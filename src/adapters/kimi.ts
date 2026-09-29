import { statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { applyTotalTokenFallback } from "../core/tokens.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { envOrDefaultDirs, filesWithExtension, isObj, nonEmpty, type Obj, readJson, readText, u64 } from "./common.ts";

const DEFAULT_MODEL = "kimi-for-coding";
const K2_6_CUTOFF_MS = 1_776_698_890_072;

const wireFiles = (): string[] => {
  const files: string[] = [];
  for (const root of envOrDefaultDirs("KIMI_DATA_DIR", (h) => [join(h, ".kimi"), join(h, ".kimi-code")])) {
    const sessions = join(root, "sessions");
    for (const file of filesWithExtension(sessions, "jsonl")) {
      if (basename(file) !== "wire.jsonl") continue;
      const depth = relative(sessions, file).split(sep).filter(Boolean).length;
      if (depth === 3 || depth === 5) files.push(file);
    }
  }
  return [...new Set(files)].sort();
};

const isAgentLayout = (file: string) => basename(dirname(dirname(file))) === "agents";

const kimiRoot = (file: string): string => (isAgentLayout(file) ? dirname(dirname(dirname(dirname(dirname(dirname(file)))))) : dirname(dirname(dirname(dirname(file)))));

const configModel = (file: string): string => {
  const config = readJson(join(kimiRoot(file), "config.json"));
  return (isObj(config) ? nonEmpty(config.model) : undefined) ?? DEFAULT_MODEL;
};

const sessionIdOf = (file: string): string => basename(isAgentLayout(file) ? dirname(dirname(dirname(file))) : dirname(file)) || "unknown";

const objOrAbsent = (value: unknown) => value === undefined || value === null || isObj(value);

const shapeOk = (line: Obj): boolean => {
  if (!objOrAbsent(line.message) || !objOrAbsent(line.usage)) return false;
  const payload = isObj(line.message) ? line.message.payload : undefined;
  if (!objOrAbsent(payload)) return false;
  return !isObj(payload) || objOrAbsent(payload.token_usage);
};

type KimiEntry = UsageEntry & { key: string };

const makeEntry = (file: string, model: string, timestamp: number, messageId: string | undefined, tokens: Obj, keys: [string, string, string, string], total: number): KimiEntry | undefined => {
  const { usage, extra } = applyTotalTokenFallback(
    { input: u64(tokens[keys[0]]), output: u64(tokens[keys[1]]), cacheCreation: u64(tokens[keys[2]]), cacheRead: u64(tokens[keys[3]]) },
    0,
    total,
  );
  if (usage.input + usage.output + usage.cacheCreation + usage.cacheRead + extra === 0) return undefined;
  const sessionId = sessionIdOf(file);
  const candidates = [...new Set([...(model === DEFAULT_MODEL ? [timestamp < K2_6_CUTOFF_MS ? "moonshot/kimi-k2.5" : "moonshot/kimi-k2.6"] : []), `moonshot/${model}`, `kimi/${model}`, model])];
  return {
    agent: "kimi",
    timestamp,
    sessionId,
    projectPath: "Kimi",
    model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheCreationTokens: usage.cacheCreation,
    cacheReadTokens: usage.cacheRead,
    extraTotalTokens: extra,
    pricingCandidates: candidates,
    candidateRule: "first-found",
    key: [sessionId, messageId ?? "", new Date(timestamp).toISOString(), model, usage.input, usage.output, usage.cacheCreation, usage.cacheRead, extra].join(":"),
  };
};

const readWireFile = (file: string): KimiEntry[] => {
  const content = readText(file);
  if (content === undefined) return [];
  const model = configModel(file);
  let fallback = 0;
  try {
    fallback = Math.floor(statSync(file).mtimeMs);
  } catch {}
  const out: KimiEntry[] = [];
  for (const raw of content.split("\n")) {
    if (!raw.includes('"token_usage"') && !raw.includes('"usage.record"')) continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObj(line) || !shapeOk(line)) continue;
    const type = nonEmpty(line.type);
    if (type === "metadata") continue;
    if (type === "usage.record") {
      if (nonEmpty(line.usageScope) !== "turn" || !isObj(line.usage)) continue;
      const timestamp = typeof line.time === "number" && Number.isInteger(line.time) ? line.time : fallback;
      const lineModel = nonEmpty(line.model) ?? DEFAULT_MODEL;
      const entry = makeEntry(file, lineModel.startsWith("kimi-code/") ? lineModel.slice("kimi-code/".length) : lineModel, timestamp, undefined, line.usage, ["inputOther", "output", "inputCacheCreation", "inputCacheRead"], 0);
      if (entry) out.push(entry);
      continue;
    }
    const message = line.message;
    if (!isObj(message) || nonEmpty(message.type) !== "StatusUpdate" || !isObj(message.payload) || !isObj(message.payload.token_usage)) continue;
    const tokens = message.payload.token_usage;
    const seconds = typeof line.timestamp === "number" && Number.isFinite(line.timestamp) ? line.timestamp : undefined;
    const timestamp = seconds === undefined ? fallback : Math.trunc(seconds * 1000);
    const entry = makeEntry(file, model, timestamp, nonEmpty(message.payload.message_id), tokens, ["input_other", "output", "input_cache_creation", "input_cache_read"], u64(tokens.total));
    if (entry) out.push(entry);
  }
  return out;
};

export const kimi: Adapter = {
  id: "kimi",
  label: "Kimi",
  product: "Kimi",
  envVars: ["KIMI_DATA_DIR"],
  reports: ["daily", "monthly", "session"],
  hasData: () => wireFiles().length > 0,
  async load(): Promise<UsageEntry[]> {
    const seen = new Set<string>();
    const entries: UsageEntry[] = [];
    for (const file of wireFiles()) {
      for (const { key, ...entry } of readWireFile(file)) {
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
      }
    }
    return entries.sort((a, b) => a.timestamp - b.timestamp);
  },
};
