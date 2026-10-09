import { readdirSync } from "node:fs";
import { join } from "node:path";
import { envPaths, home, isDir } from "../core/fs.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { byTimestamp, f64, isFile, isObj, nonEmpty, type Obj, readJson, u64 } from "./common.ts";

// DECISION: CLI-backed worker lanes are skipped, not ingested, because each CLI writes its own session logs that the claude/codex/muse/opencode/commandcode adapters already count.
const CLI_PROVIDERS = new Set(["claude", "codex", "muse", "opencode", "opencode2", "commandcode", "in-process", "fixture"]);

const cyberineHomes = (): string[] => {
  const candidates = process.env.CYBERINE_HOME !== undefined ? envPaths("CYBERINE_HOME") : [join(home(), ".cyberine")];
  return [...new Set(candidates)].filter(isDir);
};

const jsonFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
};

const runFileOf = (index: Obj): string | undefined => {
  const runId = nonEmpty(index.runId);
  if (!runId) return undefined;
  const runsDir = nonEmpty(index.runsDir);
  const cwd = nonEmpty(index.cwd);
  const candidates = [
    ...(runsDir ? [join(runsDir, "run.json"), join(runsDir, runId, "run.json")] : []),
    ...(cwd ? [join(cwd, ".local", "runs", runId, "run.json")] : []),
  ];
  return candidates.find(isFile);
};

const splitProvider = (value: unknown): [string, string] | undefined => {
  const text = nonEmpty(value);
  const colon = text?.indexOf(":") ?? -1;
  if (!text || colon <= 0 || colon === text.length - 1) return undefined;
  return [text.slice(0, colon), text.slice(colon + 1)];
};

const DIRECT_PROVIDERS = new Set(["deepseek", "xiaomi"]);

const pricingCandidatesFor = (provider: string, model: string): string[] => {
  if (DIRECT_PROVIDERS.has(provider)) return [model];
  if (provider === "ollamaCloud") return [...new Set([model.replace(/-cloud$/, ""), model])];
  return [...new Set([`${provider.toLowerCase()}/${model}`, model])];
};

const millis = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value > 1e12 ? value : value * 1000);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

type EntryInput = {
  timestamp: number;
  sessionId: string;
  projectPath: string;
  provider: string;
  model: string;
  prompt: number;
  completion: number;
  hit: number;
  miss?: number;
  costUSD?: number;
};

const makeEntry = (input: EntryInput): UsageEntry | undefined => {
  const cacheRead = Math.min(input.hit, input.prompt || input.hit);
  const uncached = input.miss ?? Math.max(input.prompt - cacheRead, 0);
  if (uncached + cacheRead + input.completion === 0 && !input.costUSD) return undefined;
  return {
    agent: "cyberine",
    timestamp: input.timestamp,
    sessionId: input.sessionId,
    projectPath: input.projectPath,
    model: input.model,
    inputTokens: uncached,
    outputTokens: input.completion,
    cacheCreationTokens: 0,
    cacheReadTokens: cacheRead,
    extraTotalTokens: 0,
    costUSD: input.costUSD,
    recordedZeroCost: input.costUSD === 0 ? true : undefined,
    pricingCandidates: pricingCandidatesFor(input.provider, input.model),
  };
};

const runEntries = (run: Obj): UsageEntry[] => {
  const runId = nonEmpty(run.runId);
  if (!runId || !Array.isArray(run.steps)) return [];
  const projectPath = nonEmpty(run.cwd) ?? "Cyberine";
  const runStart = millis(run.createdAt) ?? millis(run.updatedAt);
  const out: UsageEntry[] = [];
  for (const step of run.steps) {
    if (!isObj(step) || !Array.isArray(step.workerRuns)) continue;
    for (const worker of step.workerRuns) {
      if (!isObj(worker) || !isObj(worker.usage)) continue;
      const split = splitProvider(worker.provider);
      if (!split || CLI_PROVIDERS.has(split[0])) continue;
      const timestamp = millis(worker.startedAt) ?? millis(worker.updatedAt) ?? runStart;
      if (timestamp === undefined) continue;
      const costModel = nonEmpty(worker.costModel);
      const entry = makeEntry({
        timestamp,
        sessionId: runId,
        projectPath,
        provider: split[0],
        model: split[1],
        prompt: u64(worker.usage.inputTokens),
        completion: u64(worker.usage.outputTokens),
        hit: u64(worker.usage.cacheHitTokens),
        costUSD: costModel === "subscription" || costModel === "free" ? 0 : undefined,
      });
      if (entry) out.push(entry);
    }
  }
  return out;
};

const chatEntries = (session: Obj, fallbackId: string): UsageEntry[] => {
  const sessionId = nonEmpty(session.id) ?? fallbackId;
  const projectPath = nonEmpty(session.cwd) ?? "Cyberine chat";
  const ledger = Array.isArray(session.cacheLedger) ? session.cacheLedger.filter(isObj) : [];
  if (ledger.length > 0) {
    const out: UsageEntry[] = [];
    for (const call of ledger) {
      const timestamp = millis(call.at);
      const model = nonEmpty(call.model) ?? nonEmpty(session.model);
      if (timestamp === undefined || !model) continue;
      const miss = f64(call.miss);
      const entry = makeEntry({
        timestamp,
        sessionId,
        projectPath,
        provider: nonEmpty(call.provider) ?? nonEmpty(session.provider) ?? "deepseek",
        model,
        prompt: u64(call.prompt),
        completion: u64(call.completion),
        hit: u64(call.hit),
        miss: miss === undefined ? undefined : u64(miss),
        costUSD: f64(call.billedUsd),
      });
      if (entry) out.push(entry);
    }
    return out;
  }
  const tokens = session.sessionTokens;
  const model = nonEmpty(session.model);
  const timestamp = millis(session.updatedAt) ?? millis(session.createdAt);
  if (!isObj(tokens) || !model || timestamp === undefined) return [];
  const entry = makeEntry({
    timestamp,
    sessionId,
    projectPath,
    provider: nonEmpty(session.provider) ?? "deepseek",
    model,
    prompt: u64(tokens.prompt),
    completion: u64(tokens.completion),
    hit: 0,
    costUSD: f64(tokens.plannerUsd),
  });
  return entry ? [entry] : [];
};

const runIndexFiles = () => cyberineHomes().flatMap((root) => jsonFiles(join(root, "runs")));
const chatFiles = () => cyberineHomes().flatMap((root) => jsonFiles(join(root, "chat-sessions")));

export const cyberine: Adapter = {
  id: "cyberine",
  label: "Cyberine",
  product: "Cyberine",
  envVars: ["CYBERINE_HOME"],
  reports: ["daily", "weekly", "monthly", "session"],
  hasData: () => runIndexFiles().length > 0 || chatFiles().length > 0,
  async load(): Promise<UsageEntry[]> {
    const entries: UsageEntry[] = [];
    const seenRuns = new Set<string>();
    for (const file of runIndexFiles()) {
      const index = readJson(file);
      if (!isObj(index)) continue;
      const runFile = runFileOf(index);
      if (!runFile || seenRuns.has(runFile)) continue;
      seenRuns.add(runFile);
      const run = readJson(runFile);
      if (isObj(run)) entries.push(...runEntries(run));
    }
    for (const file of chatFiles()) {
      const session = readJson(file);
      if (isObj(session)) entries.push(...chatEntries(session, file.slice(file.lastIndexOf("/") + 1, -".json".length)));
    }
    return entries.sort(byTimestamp);
  },
};
