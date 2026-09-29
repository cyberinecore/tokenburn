import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { envPaths, home, isDir, walk } from "../core/fs.ts";
import { parseFilesParallel } from "../core/pool.ts";
import { openReadonly, probeSqlite, type ReadonlyDb } from "../core/sqlite.ts";
import { applyTotalTokenFallback, lenientUint } from "../core/tokens.ts";
import type { Adapter, LoadContext, UsageEntry } from "../core/types.ts";

type OpenCodeEntry = UsageEntry & { messageId?: string };

type Tokens = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number };

const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

const readTokens = (value: unknown): Tokens | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const t = value as Record<string, unknown>;
  const cache = t.cache && typeof t.cache === "object" && !Array.isArray(t.cache) ? (t.cache as Record<string, unknown>) : undefined;
  return {
    input: lenientUint(t.input),
    output: lenientUint(t.output),
    reasoning: lenientUint(t.reasoning),
    cacheRead: lenientUint(cache?.read),
    cacheWrite: lenientUint(cache?.write),
    total: lenientUint(t.total),
  };
};

const resolveModelName = (model: string): string =>
  model === "gemini-3-pro-high" ? "gemini-3-pro-preview" : model === "k2p6" ? "kimi-k2.6" : model;

const normalizeModelName = (model: string): string => {
  for (const family of ["claude-haiku-", "claude-opus-", "claude-sonnet-"]) {
    if (!model.startsWith(family)) continue;
    const rest = model.slice(family.length);
    const dot = rest.indexOf(".");
    if (dot >= 0) {
      const major = rest.slice(0, dot);
      const minor = rest.slice(dot + 1);
      if (/^\d+$/.test(major) && /^\d/.test(minor)) return `${family}${major}-${minor}`;
    }
    if (/^\d\d/.test(rest)) return `${family}${rest[0]}-${rest.slice(1)}`;
  }
  return model;
};

export const openCodeCandidates = (model: string, provider: string): string[] => {
  const resolved = resolveModelName(model);
  const normalized = normalizeModelName(resolved);
  const base = normalized !== resolved ? [resolved, normalized] : [resolved];
  const candidates = [...base];
  if (provider !== "unknown") {
    const prefix = provider.replaceAll("-", "_");
    candidates.push(...base.map((m) => `${prefix}/${m}`));
  }
  return candidates.filter((c, i) => c !== candidates[i - 1]);
};

type MessageLike = {
  tokens?: unknown;
  modelID?: unknown;
  providerID?: unknown;
  model?: unknown;
  time?: { created?: unknown };
  id?: unknown;
  sessionID?: unknown;
  cost?: unknown;
};

const toEntry = (
  value: MessageLike,
  id: string | undefined,
  sessionId: string | undefined,
  options: { allowCostOnly: boolean; timestampPricing: boolean; createdFallback?: number },
): OpenCodeEntry | undefined => {
  const tokens = readTokens(value.tokens);
  if (!tokens) return undefined;
  const { usage, extra } = applyTotalTokenFallback(
    { input: tokens.input, output: tokens.output, cacheCreation: tokens.cacheWrite, cacheRead: tokens.cacheRead },
    tokens.reasoning,
    tokens.total,
  );
  const cost = typeof value.cost === "number" && Number.isFinite(value.cost) ? value.cost : undefined;
  if (
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheCreation === 0 &&
    usage.cacheRead === 0 &&
    extra === 0 &&
    !(options.allowCostOnly && cost !== undefined && cost > 0)
  )
    return undefined;
  const modelRef = value.model && typeof value.model === "object" ? (value.model as Record<string, unknown>) : undefined;
  const model = nonEmpty(modelRef?.id) ?? nonEmpty(modelRef?.modelID) ?? nonEmpty(value.modelID);
  const provider = nonEmpty(modelRef?.providerID) ?? nonEmpty(value.providerID);
  if (!model || !provider) return undefined;
  const created = typeof value.time?.created === "number" ? value.time.created : options.createdFallback;
  const timestamp = created !== undefined && created > 0 ? Math.trunc(created) : 0;
  return {
    agent: "opencode",
    timestamp,
    sessionId: sessionId ?? nonEmpty(value.sessionID) ?? "unknown",
    projectPath: "OpenCode",
    model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheCreationTokens: usage.cacheCreation,
    cacheReadTokens: usage.cacheRead,
    extraTotalTokens: extra,
    extraBilledAsOutput: true,
    costUSD: cost !== undefined && cost > 0 ? cost : undefined,
    recordedZeroCost: cost === 0,
    pricingCandidates: openCodeCandidates(model, provider),
    pricingIgnoresTimestamp: !options.timestampPricing || created === undefined || created <= 0,
    messageId: id ?? nonEmpty(value.id),
  };
};

const DAY_MS = 86_400_000;

const widen = (window: { start?: number; end?: number }) => ({
  start: window.start === undefined ? undefined : window.start - DAY_MS,
  end: window.end === undefined ? undefined : window.end + DAY_MS,
});

const inWindow = (value: MessageLike, window: { start?: number; end?: number }): boolean => {
  if (window.start === undefined && window.end === undefined) return true;
  const created = value.time?.created;
  if (typeof created !== "number") return true;
  return (window.start === undefined || created >= window.start) && (window.end === undefined || created < window.end);
};

const parseJson = (text: unknown): MessageLike | undefined => {
  if (typeof text !== "string") return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const columns = (db: ReadonlyDb, table: string): Set<string> => {
  try {
    return new Set(db.all(`PRAGMA table_info(${table})`).map((row) => String(row.name)));
  } catch {
    return new Set();
  }
};

const tableExists = (db: ReadonlyDb, table: string): boolean => {
  try {
    return db.all(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '${table}' LIMIT 1`).length > 0;
  } catch {
    return false;
  }
};

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const forkCutoffs = (db: ReadonlyDb): Map<string, number> => {
  const cutoffs = new Map<string, number>();
  if (!tableExists(db, "session_v2") || !tableExists(db, "session_message")) return cutoffs;
  const v2 = columns(db, "session_v2");
  const sm = columns(db, "session_message");
  if (!["id", "fork_session_id", "fork_boundary"].every((c) => v2.has(c)) || !["id", "session_id", "seq"].every((c) => sm.has(c))) return cutoffs;
  for (const row of db.all("SELECT id, fork_session_id, fork_boundary FROM session_v2 WHERE fork_session_id IS NOT NULL AND fork_boundary IS NOT NULL")) {
    const forkId = String(row.id ?? "");
    const parentId = String(row.fork_session_id ?? "");
    if (!forkId || !parentId) continue;
    let boundary: { type?: string; messageID?: string };
    try {
      boundary = JSON.parse(String(row.fork_boundary));
    } catch {
      continue;
    }
    if (typeof boundary.type !== "string" || typeof boundary.messageID !== "string") continue;
    const seqRow = db.all(`SELECT seq FROM session_message WHERE session_id = ${sqlString(parentId)} AND id = ${sqlString(boundary.messageID)} LIMIT 1`)[0];
    if (!seqRow || typeof seqRow.seq !== "number") continue;
    if (boundary.type === "through") cutoffs.set(forkId, seqRow.seq);
    else if (boundary.type === "before") {
      const before = db.all(`SELECT MAX(seq) AS seq FROM session_message WHERE session_id = ${sqlString(parentId)} AND seq < ${seqRow.seq}`)[0];
      if (before && typeof before.seq === "number") cutoffs.set(forkId, before.seq);
    }
  }
  return cutoffs;
};

const parseSessionModel = (value: unknown): { model: string; provider: string } | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  try {
    const json = JSON.parse(text);
    if (typeof json === "string" && json.trim()) return { model: json.trim(), provider: "unknown" };
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const model = [json.id, json.modelID].find((v) => typeof v === "string" && v.trim())?.trim();
      if (!model) return undefined;
      const provider = [json.providerID, json.provider].find((v) => typeof v === "string" && v.trim())?.trim() ?? "unknown";
      return { model, provider };
    }
  } catch {}
  return { model: text, provider: "unknown" };
};

const readNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

export type DbResult = { messages: OpenCodeEntry[]; aggregates: OpenCodeEntry[] };

const FIELDS = ["tokens", "modelID", "providerID", "model", "time", "id", "sessionID", "cost"] as const;

const extractColumns = (column: string) =>
  FIELDS.map((field) => `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.${field}') END AS f_${field}`).join(", ");

const rowMessage = (row: Record<string, unknown>): MessageLike | undefined => {
  if (row.valid !== 1) return undefined;
  const parse = (value: unknown) => {
    if (typeof value !== "string") return value;
    if (!value.startsWith("{") && !value.startsWith("[")) return value;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  };
  return {
    tokens: parse(row.f_tokens),
    modelID: row.f_modelID,
    providerID: row.f_providerID,
    model: parse(row.f_model),
    time: parse(row.f_time) as MessageLike["time"],
    id: row.f_id,
    sessionID: row.f_sessionID,
    cost: row.f_cost,
  };
};

const windowClause = (column: string, window: { start?: number; end?: number }) => {
  const parts: string[] = [];
  if (window.start !== undefined) parts.push(`${column} >= ${Math.trunc(window.start)}`);
  if (window.end !== undefined) parts.push(`${column} < ${Math.trunc(window.end)}`);
  return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
};

const looksLikeMillis = (db: ReadonlyDb, table: string): boolean => {
  try {
    const row = db.all(`SELECT max(time_created) AS m FROM (SELECT time_created FROM ${table} LIMIT 8)`)[0];
    return typeof row?.m === "number" && row.m >= 100_000_000_000;
  } catch {
    return false;
  }
};

export const loadDatabase = (allowAggregates: boolean, db: ReadonlyDb, window: { start?: number; end?: number } = {}): DbResult => {
  const messages: OpenCodeEntry[] = [];
  const seen = new Set<string>();
  const sessions = new Set<string>();
  const push = (list: OpenCodeEntry[], entry: OpenCodeEntry) => {
    if (entry.messageId) {
      if (seen.has(entry.messageId)) return false;
      seen.add(entry.messageId);
    }
    list.push(entry);
    return true;
  };
  const cutoffs = forkCutoffs(db);
  if (tableExists(db, "message")) {
    try {
      const pushdown = columns(db, "message").has("time_created") && looksLikeMillis(db, "message") ? windowClause("time_created", widen(window)) : "";
      for (const row of db.all(`SELECT id, session_id, json_valid(data) AS valid, ${extractColumns("data")} FROM message${pushdown}`)) {
        if (typeof row.id !== "string" || typeof row.session_id !== "string") continue;
        const value = rowMessage(row);
        if (!value || !inWindow(value, window)) continue;
        const entry = toEntry(value, row.id, row.session_id, { allowCostOnly: false, timestampPricing: true });
        if (!entry) continue;
        sessions.add(entry.sessionId);
        push(messages, entry);
      }
    } catch {}
  }
  const hasSessionMessages = tableExists(db, "session_message");
  if (hasSessionMessages) {
    const cols = columns(db, "session_message");
    if (["id", "session_id", "type", "data"].every((c) => cols.has(c))) {
      const time = cols.has("time_created") ? "time_created" : "NULL";
      const seq = cols.has("seq") ? ", seq" : "";
      const pushdown = cols.has("time_created") && looksLikeMillis(db, "session_message") ? windowClause("time_created", widen(window)) : "";
      try {
        for (const row of db.all(
          `SELECT id, session_id, type, json_valid(data) AS valid, ${extractColumns("data")}, ${time} AS time_created${seq} FROM session_message${pushdown}`,
        )) {
          if (typeof row.id !== "string" || typeof row.session_id !== "string" || row.type !== "assistant") continue;
          const cutoff = cutoffs.get(row.session_id);
          if (cutoff !== undefined && typeof row.seq === "number" && row.seq <= cutoff) continue;
          const value = rowMessage(row);
          if (!value || !inWindow(value, window)) continue;
          const created = readNumber(row.time_created) !== undefined ? Math.trunc(row.time_created as number) : 0;
          const entry = toEntry(value, row.id, row.session_id, { allowCostOnly: false, timestampPricing: true, createdFallback: created });
          if (!entry) continue;
          sessions.add(entry.sessionId);
          push(messages, entry);
        }
      } catch {}
    }
  }
  const aggregates: OpenCodeEntry[] = [];
  if (allowAggregates) {
    const tables: string[] = [];
    if (tableExists(db, "session_v2")) tables.push("session_v2");
    if (hasSessionMessages && tableExists(db, "session")) tables.push("session");
    for (const table of tables) {
      const cols = columns(db, table);
      if (!["id", "time_created", "cost", "tokens_input", "tokens_output", "tokens_cache_read", "tokens_cache_write"].every((c) => cols.has(c))) continue;
      const reasoning = cols.has("tokens_reasoning") ? "tokens_reasoning" : "0";
      const model = cols.has("model") ? "model" : "NULL";
      let rows: Record<string, unknown>[] = [];
      try {
        rows = db.all(
          `SELECT id, time_created, cost, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, ${reasoning} AS tokens_reasoning, ${model} AS model FROM ${table}`,
        );
      } catch {
        continue;
      }
      for (const row of rows) {
        if (typeof row.id !== "string") continue;
        const created = readNumber(row.time_created);
        if (created === undefined) continue;
        const uint = (v: unknown) => (typeof v === "number" && v > 0 ? Math.trunc(v) : 0);
        const parsedModel = parseSessionModel(row.model) ?? { model: "unknown", provider: "unknown" };
        const cost = readNumber(row.cost);
        const input = uint(row.tokens_input);
        const output = uint(row.tokens_output);
        const reasoningTokens = uint(row.tokens_reasoning);
        const cacheRead = uint(row.tokens_cache_read);
        const cacheWrite = uint(row.tokens_cache_write);
        if (input === 0 && output === 0 && reasoningTokens === 0 && cacheRead === 0 && cacheWrite === 0 && (cost ?? 0) <= 0) continue;
        const entry = toEntry(
          {
            tokens: { input, output, reasoning: reasoningTokens, cache: { read: cacheRead, write: cacheWrite }, total: 0 },
            modelID: parsedModel.model,
            providerID: parsedModel.provider,
            time: { created: Math.trunc(created) },
            id: `session:${row.id}`,
            sessionID: row.id,
            cost,
          },
          undefined,
          undefined,
          { allowCostOnly: true, timestampPricing: false },
        );
        if (!entry || sessions.has(entry.sessionId)) continue;
        push(aggregates, entry);
      }
    }
  }
  return { messages, aggregates };
};

const isChannelDb = (name: string): boolean => /^opencode-[A-Za-z0-9_-]*\.db$/.test(name);

const dbPath = (dir: string): string | undefined => {
  const main = join(dir, "opencode.db");
  if (existsSync(main)) return main;
  try {
    return readdirSync(dir)
      .filter((name) => isChannelDb(name))
      .sort()
      .map((name) => join(dir, name))[0];
  } catch {
    return undefined;
  }
};

export const openCodeDirs = (): string[] => {
  if (process.env.OPENCODE_DATA_DIR !== undefined) return [...new Set(envPaths("OPENCODE_DATA_DIR"))].filter(isDir);
  const xdg = process.env.XDG_DATA_HOME?.startsWith("/") ? process.env.XDG_DATA_HOME : join(home(), ".local", "share");
  const dir = join(xdg, "opencode");
  return isDir(dir) ? [dir] : [];
};

const hasJson = (dir: string): boolean => {
  for (const _ of walk(dir, (n) => n.endsWith(".json"))) return true;
  return false;
};

const loadDbFile = async (path: string, allowAggregates: boolean, window: { start?: number; end?: number }): Promise<DbResult> => {
  const db = await openReadonly(path);
  if (!db) return { messages: [], aggregates: [] };
  try {
    return loadDatabase(allowAggregates, db, window);
  } finally {
    db.close();
  }
};

export const parseOpenCodeDb = async (files: string[], options?: Record<string, unknown>): Promise<DbResult[][]> =>
  Promise.all(files.map(async (file) => [await loadDbFile(file, Boolean(options?.allowAggregates), (options?.window as { start?: number; end?: number }) ?? {})]));

const dateWindow = (ctx: LoadContext): { start?: number; end?: number } => {
  const bound = (value: string | undefined, offsetDays: number) => {
    if (!value) return undefined;
    const ms = Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
    return ms + offsetDays * DAY_MS;
  };
  return { start: bound(ctx.since, -1), end: bound(ctx.until, 2) };
};

export const opencode: Adapter = {
  id: "opencode",
  label: "OpenCode",
  product: "OpenCode",
  envVars: ["OPENCODE_DATA_DIR"],
  reports: ["daily", "weekly", "monthly", "session"],
  hasData: () => openCodeDirs().some((dir) => dbPath(dir) !== undefined || hasJson(join(dir, "storage", "message"))),
  parseFiles: (files, options) => parseOpenCodeDb(files, options),
  async load(ctx: LoadContext): Promise<UsageEntry[]> {
    const allowAggregates = ctx.kind === "session" && !ctx.since && !ctx.until && ctx.last === undefined;
    const window = dateWindow(ctx);
    const entries: OpenCodeEntry[] = [];
    const seen = new Set<string>();
    const messageSessions = new Set<string>();
    const aggregates: OpenCodeEntry[] = [];
    for (const dir of openCodeDirs()) {
      const local: OpenCodeEntry[] = [];
      const localSeen = new Set<string>();
      const db = dbPath(dir);
      if (db) {
        await probeSqlite(db);
        const [perFile] = await parseFilesParallel<DbResult>({ parser: "opencode", files: [db], options: { allowAggregates, window } }, parseOpenCodeDb);
        const loaded = perFile?.[0] ?? { messages: [], aggregates: [] };
        for (const entry of loaded.messages) {
          if (entry.messageId) {
            if (localSeen.has(entry.messageId)) continue;
            localSeen.add(entry.messageId);
          }
          local.push(entry);
        }
        aggregates.push(...loaded.aggregates);
      }
      const files = [...walk(join(dir, "storage", "message"), (n) => n.endsWith(".json"))].sort();
      for (const file of files) {
        if (localSeen.size && localSeen.has(basename(file, ".json"))) continue;
        let value: MessageLike | undefined;
        try {
          value = parseJson(readFileSync(file, "utf8"));
        } catch {
          continue;
        }
        if (!value) continue;
        const entry = toEntry(value, undefined, undefined, { allowCostOnly: false, timestampPricing: true });
        if (!entry) continue;
        if (entry.messageId) {
          if (localSeen.has(entry.messageId)) continue;
          localSeen.add(entry.messageId);
        }
        local.push(entry);
      }
      for (const entry of local) {
        messageSessions.add(entry.sessionId);
        if (entry.messageId) {
          if (seen.has(entry.messageId)) continue;
          seen.add(entry.messageId);
        }
        entries.push(entry);
      }
    }
    for (const entry of aggregates) {
      if (messageSessions.has(entry.sessionId)) continue;
      if (entry.messageId) {
        if (seen.has(entry.messageId)) continue;
        seen.add(entry.messageId);
      }
      entries.push(entry);
    }
    return entries.sort((a, b) => a.timestamp - b.timestamp);
  },
};
