import { readFileSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { envPaths, expandHome, home, isDir, walk } from "../core/fs.ts";
import { parseFilesParallel } from "../core/pool.ts";
import type { Adapter, LoadContext, UsageEntry } from "../core/types.ts";

type RawUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  speed?: string;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  iterations?: { type?: string; model?: string | null; input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; cache_creation?: RawUsage["cache_creation"]; speed?: string }[];
};

type RawLine = {
  sessionId?: string;
  timestamp?: string;
  version?: string;
  costUSD?: number;
  requestId?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  message?: { usage?: RawUsage; model?: string; id?: string };
};

const LIMIT_MARKER = "Claude AI usage limit reached";

const usageLimitReset = (line: string, data: RawLine): number | undefined => {
  if (data.isApiErrorMessage !== true) return undefined;
  const at = line.indexOf(LIMIT_MARKER);
  if (at < 0) return undefined;
  const pipe = line.indexOf("|", at);
  if (pipe < 0) return undefined;
  const digits = /^\d+/.exec(line.slice(pipe + 1))?.[0];
  const seconds = digits ? Number(digits) : 0;
  return seconds > 0 ? seconds * 1000 : undefined;
};

type ClaudeEntry = UsageEntry & {
  messageId?: string;
  requestId?: string;
  dataSessionId?: string;
  isSidechain: boolean;
};

const NULL_FORBIDDEN = new Set([
  "id",
  "cwd",
  "model",
  "speed",
  "costUSD",
  "version",
  "sessionId",
  "requestId",
  "isApiErrorMessage",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
]);

const hasForbiddenNull = (value: unknown, iterationArrays: unknown[], allowModel = false): boolean => {
  if (Array.isArray(value)) {
    const isIteration = iterationArrays.includes(value);
    return value.some((item) => hasForbiddenNull(item, iterationArrays, isIteration));
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (child === null && NULL_FORBIDDEN.has(key)) {
        if (!(allowModel && key === "model")) return true;
        continue;
      }
      if (hasForbiddenNull(child, iterationArrays)) return true;
    }
  }
  return false;
};

const isSemverPrefix = (value: string): boolean => /^\d+\.\d+\.\d/.test(value);

const isUint = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

const optionalUint = (value: unknown): boolean => value === undefined || isUint(value);

const validUsage = (usage: RawUsage | undefined): usage is RawUsage =>
  !!usage &&
  isUint(usage.input_tokens) &&
  isUint(usage.output_tokens) &&
  optionalUint(usage.cache_creation_input_tokens) &&
  optionalUint(usage.cache_read_input_tokens) &&
  (usage.speed === undefined || usage.speed === "standard" || usage.speed === "fast");

const cacheCounts = (usage: RawUsage) => {
  if (usage.cache_creation && typeof usage.cache_creation === "object") {
    const fiveMinute = usage.cache_creation.ephemeral_5m_input_tokens ?? 0;
    const oneHour = usage.cache_creation.ephemeral_1h_input_tokens ?? 0;
    return { total: fiveMinute + oneHour, oneHour };
  }
  return { total: usage.cache_creation_input_tokens ?? 0, oneHour: 0 };
};

export const claudeRoots = (): string[] => {
  const seen = new Set<string>();
  const roots: string[] = [];
  const add = (raw: string) => {
    let path = expandHome(raw);
    if (basename(path) === "projects" && isDir(path)) path = join(path, "..");
    if (isDir(join(path, "projects")) && !seen.has(path)) {
      seen.add(path);
      roots.push(path);
    }
  };
  if (process.env.CLAUDE_CONFIG_DIR !== undefined) {
    for (const path of envPaths("CLAUDE_CONFIG_DIR")) add(path);
    return roots;
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(home(), ".config");
  add(join(xdg, "claude"));
  add(join(home(), ".claude"));
  return roots;
};

export const sessionParts = (path: string): { sessionId: string; projectPath: string } => {
  const parts = path.split(sep);
  const index = parts.indexOf("projects");
  const relative = index >= 0 ? parts.slice(index + 1) : parts;
  const last = relative[relative.length - 1] ?? "";
  const fileSession = last.endsWith(".jsonl") && last.length > 6 ? last.slice(0, -6) : undefined;
  if (relative.length === 2 && fileSession) return { sessionId: fileSession, projectPath: relative[0]! };
  if (relative.length >= 4 && relative[relative.length - 2] === "subagents") {
    const projectPath = relative.slice(0, relative.length - 3).join(sep);
    return { sessionId: relative[relative.length - 3]!, projectPath: projectPath || "Unknown Project" };
  }
  return {
    sessionId: relative[Math.max(relative.length - 2, 0)] ?? "unknown",
    projectPath: relative.length > 2 ? relative.slice(0, relative.length - 2).join(sep) : "Unknown Project",
  };
};

const USAGE_MARKER = Buffer.from('"usage":{');

export const forEachMarkedLine = (path: string, marker: Buffer, visit: (line: string) => void): void => {
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch {
    return;
  }
  let from = 0;
  while (from < content.length) {
    const at = content.indexOf(marker, from);
    if (at < 0) return;
    const lineStart = content.lastIndexOf(10, at) + 1;
    let lineEnd = content.indexOf(10, at);
    if (lineEnd < 0) lineEnd = content.length;
    visit(content.toString("utf8", lineStart, lineEnd));
    from = lineEnd + 1;
  }
};

const parseFile = (path: string, out: ClaudeEntry[]): void => {
  const { sessionId, projectPath } = sessionParts(path);
  forEachMarkedLine(path, USAGE_MARKER, (line) => parseLine(line, sessionId, projectPath, out));
};

export const parseClaudeFiles = (files: string[]): ClaudeEntry[][] =>
  files.map((file) => {
    const out: ClaudeEntry[] = [];
    parseFile(file, out);
    return out;
  });

const parseLine = (line: string, sessionId: string, projectPath: string, out: ClaudeEntry[]): void => {
    let data: RawLine;
    try {
      data = JSON.parse(line) as RawLine;
    } catch {
      return;
    }
    if (!data || typeof data !== "object" || typeof data.timestamp !== "string") return;
    const usage = data.message?.usage;
    if (!validUsage(usage)) return;
    if (line.includes("null")) {
      const iterationArrays = [usage.iterations, (data as { data?: { message?: { message?: { usage?: RawUsage } } } }).data?.message?.message?.usage?.iterations].filter(Boolean);
      if (hasForbiddenNull(data, iterationArrays)) return;
    }
    const timestamp = Date.parse(data.timestamp);
    if (Number.isNaN(timestamp)) return;
    if (data.version !== undefined && (typeof data.version !== "string" || !isSemverPrefix(data.version))) return;
    if (data.sessionId === "" || data.requestId === "" || data.message?.id === "" || data.message?.model === "") return;
    const rawModel = data.message?.model;
    const fast = usage.speed === "fast";
    const model = rawModel && rawModel !== "<synthetic>" ? (fast ? `${rawModel}-fast` : rawModel) : undefined;
    const cache = cacheCounts(usage);
    const entry: ClaudeEntry = {
      agent: "claude",
      timestamp,
      sessionId,
      projectPath,
      model,
      pricingModel: rawModel,
      inputTokens: usage.input_tokens as number,
      outputTokens: usage.output_tokens as number,
      cacheCreationTokens: cache.total,
      cacheCreation1hTokens: cache.oneHour,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      extraTotalTokens: 0,
      costUSD: typeof data.costUSD === "number" ? data.costUSD : undefined,
      speed: fast ? "fast" : undefined,
      version: data.version,
      messageId: data.message?.id,
      requestId: data.requestId,
      dataSessionId: data.sessionId,
      isSidechain: data.isSidechain === true,
      usageLimitResetTime: usageLimitReset(line, data),
    };
    out.push(entry);
    if (line.includes('"advisor_message"') && Array.isArray(usage.iterations)) {
      usage.iterations.forEach((iteration, index) => {
        if (iteration.type !== "advisor_message" || !iteration.model) return;
        const advisorCache = cacheCounts(iteration as RawUsage);
        out.push({
          ...entry,
          model: iteration.model,
          pricingModel: iteration.model,
          inputTokens: iteration.input_tokens ?? 0,
          outputTokens: iteration.output_tokens ?? 0,
          cacheCreationTokens: advisorCache.total,
          cacheCreation1hTokens: advisorCache.oneHour,
          cacheReadTokens: iteration.cache_read_input_tokens ?? 0,
          costUSD: undefined,
          speed: iteration.speed === "fast" ? "fast" : undefined,
          messageId: entry.messageId ? `${entry.messageId}:advisor:${index}` : undefined,
        });
      });
    }
};

const tokenTotal = (e: ClaudeEntry) => e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;

const shouldReplace = (candidate: ClaudeEntry, existing: ClaudeEntry): boolean => {
  if (candidate.isSidechain !== existing.isSidechain) return existing.isSidechain;
  const a = tokenTotal(candidate);
  const b = tokenTotal(existing);
  if (a !== b) return a > b;
  return candidate.speed !== undefined && existing.speed === undefined;
};

const sessionOf = (e: ClaudeEntry) => e.dataSessionId ?? e.sessionId;

export const dedupeClaude = (entries: ClaudeEntry[]): ClaudeEntry[] => {
  const kept: ClaudeEntry[] = [];
  const exact = new Map<string, number>();
  const replayRoutes = new Map<string, { index: number; session: string }[]>();
  const route = (kind: string, messageId: string, session: string) => `${kind}\u0000${messageId}\u0000${session}`;
  const pushRoute = (key: string, index: number, session: string) => {
    let list = replayRoutes.get(key);
    if (!list) replayRoutes.set(key, (list = []));
    if (!list.some((item) => item.index === index && item.session === session)) list.push({ index, session });
  };
  const exactKey = (e: ClaudeEntry) =>
    e.requestId !== undefined
      ? `${e.messageId}\u0000${e.requestId}`
      : `${e.messageId}\u0000\u0001\u0000${sessionOf(e)}\u0000${e.timestamp}`;
  const indexRoutes = (e: ClaudeEntry, index: number) => {
    if (!e.messageId) return;
    const session = sessionOf(e);
    pushRoute(route("replay", e.messageId, session), index, session);
    if (e.isSidechain) pushRoute(route("replay-entry", e.messageId, session), index, session);
  };

  for (const entry of entries) {
    if (!entry.messageId) {
      kept.push(entry);
      continue;
    }
    const session = sessionOf(entry);
    const key = exactKey(entry);
    let index = exact.get(key);
    if (index === undefined) {
      const routeKey = entry.isSidechain ? route("replay", entry.messageId, session) : route("replay-entry", entry.messageId, session);
      const requestless = entry.requestId === undefined;
      for (const candidate of replayRoutes.get(routeKey) ?? []) {
        const existing = kept[candidate.index]!;
        if (candidate.session !== session) continue;
        if (existing.messageId !== entry.messageId) continue;
        const bothRequestless = requestless && existing.requestId === undefined;
        if (!(bothRequestless || existing.timestamp === entry.timestamp)) continue;
        if (!(entry.isSidechain || existing.isSidechain)) continue;
        index = candidate.index;
        break;
      }
    }
    if (index === undefined) {
      index = kept.length;
      kept.push(entry);
      exact.set(key, index);
      indexRoutes(entry, index);
      continue;
    }
    const existing = kept[index]!;
    const existingSession = sessionOf(existing);
    if (existingSession !== session) {
      for (const s of [session, existingSession]) {
        pushRoute(route("replay", entry.messageId, s), index, s);
        pushRoute(route("replay-entry", entry.messageId, s), index, s);
      }
    }
    if (shouldReplace(entry, existing)) {
      kept[index] = entry;
      if (!exact.has(key)) exact.set(key, index);
      indexRoutes(entry, index);
    }
  }
  return kept;
};

const MTIME_MARGIN_MS = 86_400_000;

export const claude: Adapter = {
  id: "claude",
  label: "Claude",
  product: "Claude Code",
  envVars: ["CLAUDE_CONFIG_DIR"],
  reports: ["daily", "weekly", "monthly", "session"],
  sessionStyle: "claude",
  hasData: () => claudeRoots().length > 0,
  parseFiles: parseClaudeFiles,
  async load(ctx: LoadContext): Promise<UsageEntry[]> {
    const files: string[] = [];
    for (const root of claudeRoots()) for (const file of walk(join(root, "projects"), (n) => n.endsWith(".jsonl"))) files.push(file);
    files.sort();
    const sinceMs = ctx.since ? sinceToMs(ctx.since) : undefined;
    const keep = new Set(files);
    if (sinceMs !== undefined && sinceMs <= Date.now()) {
      const groups = new Map<string, string[]>();
      for (const file of files) {
        const { sessionId } = sessionParts(file);
        let list = groups.get(sessionId);
        if (!list) groups.set(sessionId, (list = []));
        list.push(file);
      }
      for (const list of groups.values()) {
        const stale = list.every((file) => {
          try {
            return statSync(file).mtimeMs < sinceMs - MTIME_MARGIN_MS;
          } catch {
            return false;
          }
        });
        if (stale) for (const file of list) keep.delete(file);
      }
    }
    const kept = files.filter((file) => keep.has(file));
    const perFile = await parseFilesParallel<ClaudeEntry>({ parser: "claude", files: kept }, parseClaudeFiles);
    const entries = perFile.flat();
    return dedupeClaude(entries);
  },
};

const sinceToMs = (since: string): number => {
  const date = `${since.slice(0, 4)}-${since.slice(4, 6)}-${since.slice(6, 8)}T00:00:00Z`;
  return Date.parse(date) - 14 * 3_600_000;
};

