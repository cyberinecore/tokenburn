import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { envPaths, home, isDir, walk } from "../core/fs.ts";
import { applyTotalTokenFallback } from "../core/tokens.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";

const PROVIDER_PREFIXES = ["google", "gemini", "vertex_ai", "openrouter/google"];

type Tokens = { input: number; output: number; cached: number; thoughts: number; tool: number; total?: number };
type Obj = Record<string, unknown>;

const asObj = (value: unknown): Obj | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : undefined);

const tokenValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(Math.max(value, 0)) : undefined;

const pick = (record: Obj, keys: string[]) => keys.map((k) => tokenValue(record[k])).find((v) => v !== undefined) ?? 0;

const parseTokens = (value: unknown): Tokens | undefined => {
  const r = asObj(value);
  if (!r) return undefined;
  return {
    input: pick(r, ["input", "prompt", "input_tokens", "prompt_tokens"]),
    output: pick(r, ["output", "candidates", "output_tokens", "candidates_tokens"]),
    cached: pick(r, ["cached", "cached_tokens"]),
    thoughts: pick(r, ["thoughts", "reasoning", "thoughts_tokens", "reasoning_tokens"]),
    tool: pick(r, ["tool", "tool_tokens"]),
    total: tokenValue(r.total ?? r.total_tokens),
  };
};

const subtractCachedOverlap = (t: Tokens): [number, number] => [t.input - Math.min(t.input, t.cached), t.cached];

const normalizeSessionInput = (t: Tokens): [number, number] => {
  const inclusive = t.input + t.output + t.thoughts + t.tool;
  const exclusive = inclusive + t.cached;
  if (t.cached > 0 && t.total === inclusive && t.total !== exclusive) return subtractCachedOverlap(t);
  return [t.input, t.cached];
};

const parseTs = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
};

const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

type GeminiEntry = UsageEntry & { messageId?: string };

const buildEntry = (
  model: string | undefined,
  sessionId: string,
  timestamp: number,
  tokens: Tokens,
  normalize: (t: Tokens) => [number, number],
  messageId: string | undefined,
): GeminiEntry | undefined => {
  if (!model || !model.trim()) return undefined;
  const [inputWithoutCache, cacheRead] = normalize(tokens);
  const input = inputWithoutCache + tokens.tool;
  const total = tokens.total ?? input + tokens.output + cacheRead + tokens.thoughts;
  const { usage, extra } = applyTotalTokenFallback({ input, output: tokens.output, cacheCreation: 0, cacheRead }, tokens.thoughts, total);
  if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && extra === 0) return undefined;
  const displayExtra = Math.max(total - (usage.input + usage.output + usage.cacheRead), 0);
  const candidates = [...new Set([...PROVIDER_PREFIXES.map((p) => `${p}/${model}`), model])];
  return {
    agent: "gemini",
    timestamp,
    sessionId,
    projectPath: "Gemini",
    model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheCreationTokens: 0,
    cacheReadTokens: usage.cacheRead,
    extraTotalTokens: displayExtra,
    extraBilledAsOutput: true,
    billedExtraOutputTokens: extra,
    pricingCandidates: candidates,
    candidateRule: "first-found",
    messageId,
  };
};

const statsEntries = (stats: unknown, modelHint: string | undefined, sessionId: string, timestamp: number): GeminiEntry[] => {
  const s = asObj(stats);
  if (!s) return [];
  const models = asObj(s.models);
  if (models) {
    const out = Object.entries(models)
      .map(([model, data]) => {
        const tokens = parseTokens(asObj(data)?.tokens);
        return tokens ? buildEntry(model, sessionId, timestamp, tokens, subtractCachedOverlap, undefined) : undefined;
      })
      .filter((e): e is GeminiEntry => Boolean(e));
    if (out.length) return out;
  }
  const tokens = parseTokens(s);
  if (!tokens) return [];
  const entry = buildEntry(modelHint ?? "unknown", sessionId, timestamp, tokens, subtractCachedOverlap, undefined);
  return entry ? [entry] : [];
};

const mtime = (file: string): number => {
  try {
    return Math.floor(statSync(file).mtimeMs);
  } catch {
    return 0;
  }
};

const statsOf = (record: Obj) => record.stats ?? asObj(record.result)?.stats;

const parseJsonFile = (file: string): GeminiEntry[] => {
  const fallback = mtime(file);
  let record: Obj | undefined;
  try {
    record = asObj(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
  if (!record) return [];
  const sessionId = nonEmpty(record.sessionId) ?? nonEmpty(record.session_id) ?? basename(file).replace(/\.[^.]+$/, "");
  const sessionTs = parseTs(record.startTime) ?? parseTs(record.lastUpdated) ?? fallback;
  if (Array.isArray(record.messages)) {
    return record.messages
      .map(asObj)
      .filter((m): m is Obj => Boolean(m) && m!.type === "gemini")
      .map((m) => {
        const tokens = parseTokens(m.tokens);
        if (!tokens) return undefined;
        const ts = parseTs(m.timestamp) ?? parseTs(m.created_at) ?? sessionTs;
        return buildEntry(nonEmpty(m.model), sessionId, ts, tokens, normalizeSessionInput, nonEmpty(m.id));
      })
      .filter((e): e is GeminiEntry => Boolean(e));
  }
  if (record.type === "gemini") {
    const tokens = parseTokens(record.tokens);
    if (!tokens) return [];
    const ts = parseTs(record.timestamp) ?? parseTs(record.created_at) ?? fallback;
    const entry = buildEntry(nonEmpty(record.model), sessionId, ts, tokens, normalizeSessionInput, nonEmpty(record.id));
    return entry ? [entry] : [];
  }
  return statsEntries(statsOf(record), nonEmpty(record.model), sessionId, parseTs(record.timestamp) ?? fallback);
};

const parseJsonlFile = (file: string): GeminiEntry[] => {
  const fallback = mtime(file);
  let sessionId = basename(file).replace(/\.[^.]+$/, "");
  let currentModel: string | undefined;
  const events: GeminiEntry[] = [];
  const byId = new Map<string, number>();
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let record: Obj | undefined;
    try {
      record = asObj(JSON.parse(line));
    } catch {
      continue;
    }
    if (!record) continue;
    sessionId = nonEmpty(record.sessionId) ?? nonEmpty(record.session_id) ?? sessionId;
    currentModel = nonEmpty(record.model) ?? currentModel;
    if (record.type === "gemini") {
      const tokens = parseTokens(record.tokens);
      if (!tokens) continue;
      const ts = parseTs(record.timestamp) ?? parseTs(record.created_at) ?? fallback;
      const entry = buildEntry(nonEmpty(record.model) ?? currentModel, sessionId, ts, tokens, normalizeSessionInput, nonEmpty(record.id));
      if (!entry) continue;
      const id = nonEmpty(record.id);
      if (id && byId.has(id)) events[byId.get(id)!] = entry;
      else {
        if (id) byId.set(id, events.length);
        events.push(entry);
      }
      continue;
    }
    const stats = statsOf(record);
    if (stats) events.push(...statsEntries(stats, currentModel, sessionId, parseTs(record.timestamp) ?? fallback));
  }
  return events;
};

export const geminiRoots = (): string[] => {
  if (process.env.GEMINI_DATA_DIR !== undefined) return [...new Set(envPaths("GEMINI_DATA_DIR"))].filter(isDir);
  const dir = join(home(), ".gemini", "tmp");
  return isDir(dir) ? [dir] : [];
};

const geminiFiles = (): string[] => {
  const files = new Set<string>();
  for (const root of geminiRoots()) for (const file of walk(root, (n) => n.endsWith(".json") || n.endsWith(".jsonl"))) files.add(file);
  return [...files].sort();
};

export const gemini: Adapter = {
  id: "gemini",
  label: "Gemini CLI",
  product: "Gemini CLI",
  envVars: ["GEMINI_DATA_DIR"],
  reports: ["daily", "monthly", "session"],
  hasData: () => geminiRoots().length > 0,
  async load(): Promise<UsageEntry[]> {
    const events = geminiFiles().flatMap((file) => (file.endsWith(".jsonl") ? parseJsonlFile(file) : parseJsonFile(file)));
    return events.sort((a, b) => a.timestamp - b.timestamp);
  },
};
