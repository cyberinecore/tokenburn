import { basename, dirname, join } from "node:path";
import { home, isDir } from "../core/fs.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { filesWithExtension, isFile, isObj, nonEmpty, type Obj, readJson, readText, u64 } from "./common.ts";

const grokRoot = (): string | undefined => {
  const env = process.env.GROK_HOME?.trim();
  const path = env ? env : join(home(), ".grok");
  return isDir(path) ? path : undefined;
};

const updateFiles = (): string[] => {
  const root = grokRoot();
  if (!root) return [];
  const sessions = join(root, "sessions");
  if (!isDir(sessions)) return [];
  return filesWithExtension(sessions, "jsonl")
    .filter((file) => basename(file) === "updates.jsonl")
    .sort();
};

const urlDecode = (value: string): string => {
  const bytes = Buffer.from(value, "utf8");
  const out: number[] = [];
  const hex = (b: number) => (b >= 48 && b <= 57 ? b - 48 : b >= 97 && b <= 102 ? b - 87 : b >= 65 && b <= 70 ? b - 55 : undefined);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 37 && i + 2 < bytes.length) {
      const hi = hex(bytes[i + 1]!);
      const lo = hex(bytes[i + 2]!);
      if (hi !== undefined && lo !== undefined) {
        out.push(hi * 16 + lo);
        i += 2;
        continue;
      }
    }
    out.push(bytes[i]!);
  }
  return Buffer.from(out).toString("utf8");
};

const sessionMeta = (updates: string) => {
  let sessionId = basename(dirname(updates)) || "unknown";
  let projectPath = urlDecode(basename(dirname(dirname(updates)))) || "unknown";
  let defaultModel: string | undefined;
  const summaryPath = join(dirname(updates), "summary.json");
  const summary = isFile(summaryPath) ? readJson(summaryPath) : undefined;
  if (isObj(summary) && (summary.info === undefined || summary.info === null || isObj(summary.info))) {
    const info = isObj(summary.info) ? summary.info : undefined;
    sessionId = nonEmpty(info?.id) ?? sessionId;
    projectPath = nonEmpty(info?.cwd) ?? nonEmpty(summary.git_root_dir) ?? projectPath;
    defaultModel = nonEmpty(summary.current_model_id);
  }
  return { sessionId, projectPath, defaultModel };
};

const objOrAbsent = (value: unknown) => value === undefined || value === null || isObj(value);

const shapeOk = (line: Obj): boolean => {
  const params = line.params;
  if (!objOrAbsent(params)) return false;
  if (!isObj(params)) return true;
  if (!objOrAbsent(params.update) || !objOrAbsent(params._meta)) return false;
  const update = params.update;
  if (!isObj(update)) return true;
  if (!objOrAbsent(update.usage)) return false;
  const usage = update.usage;
  if (!isObj(usage) || usage.modelUsage === undefined || usage.modelUsage === null) return true;
  return isObj(usage.modelUsage) && Object.values(usage.modelUsage).every(isObj);
};

const asInt = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined);

const pricingCandidates = (raw: string): string[] => {
  const stripped = (raw.startsWith("[grok] ") ? raw.slice("[grok] ".length) : raw).trim();
  if (!stripped) return [];
  const normalized = stripped.endsWith("-build") ? stripped.slice(0, -"-build".length) : stripped;
  return [...new Set([stripped, `xai/${stripped}`, `x-ai/${stripped}`, normalized, `xai/${normalized}`, `x-ai/${normalized}`])];
};

type GrokEntry = UsageEntry & { eventId?: string };

const parseUpdates = (file: string): GrokEntry[] => {
  const meta = sessionMeta(file);
  const out: GrokEntry[] = [];
  const seen = new Set<string>();
  for (const raw of (readText(file) ?? "").split("\n")) {
    if (!raw.includes('"turn_completed"')) continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObj(line) || !shapeOk(line)) continue;
    const params = line.params;
    if (!isObj(params) || !isObj(params.update) || nonEmpty(params.update.sessionUpdate) !== "turn_completed" || !isObj(params.update.usage)) continue;
    const usage: Obj = params.update.usage;
    const metaObj = isObj(params._meta) ? params._meta : undefined;
    const eventId = nonEmpty(metaObj?.eventId);
    const agentMs = asInt(metaObj?.agentTimestampMs);
    const seconds = asInt(line.timestamp);
    const timestamp = agentMs !== undefined && agentMs > 0 ? agentMs : seconds !== undefined && seconds > 0 ? seconds * 1000 : 0;
    const sessionId = nonEmpty(params.sessionId) ?? meta.sessionId;
    const modelUsage = isObj(usage.modelUsage) ? usage.modelUsage : undefined;
    const rows: [string, Obj][] =
      modelUsage && Object.keys(modelUsage).length > 0
        ? Object.keys(modelUsage)
            .sort()
            .map((model) => [model, modelUsage[model]])
        : [[meta.defaultModel ?? "unknown", usage]];
    for (const [model, u] of rows) {
      const input = u64(u.inputTokens);
      const cacheRead = Math.min(u64(u.cachedReadTokens), input);
      const uncachedAll = input - cacheRead;
      const cacheCreation = Math.min(u64(u.cacheCreationTokens), uncachedAll);
      const uncached = uncachedAll - cacheCreation;
      const output = u64(u.outputTokens);
      const reasoning = u64(u.reasoningTokens);
      if (uncached === 0 && cacheRead === 0 && cacheCreation === 0 && output === 0 && reasoning === 0) continue;
      const key = eventId ? `${eventId}|${model}` : `${sessionId}|${timestamp}|${model}|${uncached}|${output}|${cacheRead}|${cacheCreation}|${reasoning}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ticks = u64(u.costUsdTicks);
      const candidates = pricingCandidates(model);
      out.push({
        agent: "grok",
        timestamp,
        sessionId,
        projectPath: meta.projectPath,
        model,
        inputTokens: uncached,
        outputTokens: output,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        extraTotalTokens: 0,
        reasoningOutputTokens: reasoning,
        costUSD: ticks > 0 ? ticks / 1e10 : undefined,
        exactPricingCandidates: candidates,
        pricingCandidates: candidates,
        candidateRule: "first-found",
        eventId,
      });
    }
  }
  return out;
};

export const grok: Adapter = {
  id: "grok",
  label: "Grok",
  product: "Grok Build CLI",
  envVars: ["GROK_HOME"],
  reports: ["daily", "monthly", "session"],
  sessionStyle: "entries-with-activity",
  hasData: () => updateFiles().length > 0,
  async load(): Promise<UsageEntry[]> {
    const seen = new Set<string>();
    const entries: UsageEntry[] = [];
    for (const file of updateFiles()) {
      for (const { eventId, ...entry } of parseUpdates(file)) {
        if (eventId !== undefined) {
          const key = `${eventId}|${entry.model ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        entries.push(entry);
      }
    }
    return entries.sort((a, b) => a.timestamp - b.timestamp);
  },
};
