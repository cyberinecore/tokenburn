import { lstatSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { home, isDir, listDir, walk } from "../core/fs.ts";
import { openReadonly } from "../core/sqlite.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { applyTotalTokenFallback } from "../core/tokens.ts";
import { isObj, nonEmpty, type Obj, parseTsTimestamp, readText, sqlInt, sqlText, u64 } from "./common.ts";

export const openclawRoots = (): string[] => {
  const raw = process.env.OPENCLAW_DIR;
  if (raw !== undefined && raw.trim())
    return [
      ...new Set(
        raw
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      ),
    ].filter(isDir);
  return [".openclaw", ".clawdbot", ".moltbot", ".moldbot"].map((dir) => join(home(), dir)).filter(isDir);
};

const isSessionFile = (name: string): boolean => {
  const index = name.indexOf(".jsonl");
  if (index < 0) return false;
  const suffix = name.slice(index);
  return suffix === ".jsonl" || suffix.startsWith(".jsonl.deleted.") || suffix.startsWith(".jsonl.reset.");
};

const sessionFiles = (root: string): string[] => [...walk(root, isSessionFile)].sort();

const lexicalKind = (path: string): "dir" | "file" | undefined => {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
};

const agentDatabases = (root: string): string[] => {
  const agents = join(root, "agents");
  if (lexicalKind(agents) !== "dir") return [];
  const out: string[] = [];
  for (const name of listDir(agents)) {
    if (lexicalKind(join(agents, name)) !== "dir") continue;
    const agentDir = join(agents, name, "agent");
    if (lexicalKind(agentDir) !== "dir") continue;
    const path = join(agentDir, "openclaw-agent.sqlite");
    if (lexicalKind(path) === "file") out.push(path);
  }
  return out.sort();
};

const optString = (value: unknown) => value === undefined || value === null || typeof value === "string";

const parseLine = (raw: string): Obj | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObj(value) || !optString(value.type) || !optString(value.customType)) return undefined;
  return value;
};

const messageOf = (line: Obj): Obj | undefined => {
  const message = line.message;
  if (!isObj(message) || !optString(message.role)) return undefined;
  if (message.usage !== undefined && message.usage !== null && !isObj(message.usage)) return undefined;
  return message;
};

const isModelChange = (line: Obj) => line.type === "model_change" || (line.type === "custom" && line.customType === "model-snapshot");

const modelChange = (line: Obj): [string | undefined, string | undefined] => {
  const source = isObj(line.data) ? line.data : line;
  return [nonEmpty(source.modelId) ?? nonEmpty(source.model), nonEmpty(source.provider)];
};

const timestampFrom = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const ms = Math.trunc(value);
    return ms >= 0 ? ms : undefined;
  }
  return typeof value === "string" ? parseTsTimestamp(value) : undefined;
};

type ClawEntry = UsageEntry & { messageId?: string; migrationId: string; entryId: string };

const transcriptEntry = (line: Obj, sessionId: string, model: string | undefined, provider: string | undefined, fallback: number, withId: boolean): ClawEntry | undefined => {
  if (line.type !== "message") return undefined;
  const message = messageOf(line);
  if (!message || message.role !== "assistant" || !isObj(message.usage)) return undefined;
  const usage = message.usage;
  const totalRaw = u64(usage.totalTokens);
  const { usage: tokens, extra } = applyTotalTokenFallback(
    { input: u64(usage.input), output: u64(usage.output), cacheCreation: u64(usage.cacheWrite), cacheRead: u64(usage.cacheRead) },
    0,
    totalRaw,
  );
  const known = tokens.input + tokens.output + tokens.cacheCreation + tokens.cacheRead;
  if (known + extra === 0) return undefined;
  const total = Math.max(totalRaw, known + extra);
  const messageTimestamp = message.timestamp === null ? undefined : message.timestamp;
  const timestamp = timestampFrom(messageTimestamp ?? line.timestamp) ?? fallback;
  const rawModel = nonEmpty(message.modelId) ?? nonEmpty(message.model) ?? model ?? "unknown";
  const display = `[openclaw] ${rawModel}`;
  const cost = isObj(usage.cost) && typeof usage.cost.total === "number" ? usage.cost.total : undefined;
  const extraTotal = Math.max(total - known, 0);
  const migrationId = ["openclaw", sessionId, new Date(timestamp).toISOString(), display, tokens.input, tokens.output, tokens.cacheCreation, tokens.cacheRead, extraTotal].join(":");
  return {
    agent: "openclaw",
    timestamp,
    sessionId,
    projectPath: "OpenClaw",
    model: display,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheCreationTokens: tokens.cacheCreation,
    cacheReadTokens: tokens.cacheRead,
    extraTotalTokens: extraTotal,
    costUSD: cost,
    version: nonEmpty(message.provider) ?? provider,
    exactPricingCandidates: [display],
    pricingCandidates: [rawModel],
    candidateRule: "first-found",
    messageId: withId ? nonEmpty(line.id) : undefined,
    migrationId,
    entryId: `${migrationId}:${cost ?? "calc"}`,
  };
};

const sessionIdOf = (file: string): string => {
  const name = basename(file);
  const index = name.indexOf(".jsonl");
  if (index < 0) return name;
  return index === 0 ? name : name.slice(0, index);
};

const parseSessionFile = (file: string): ClawEntry[] => {
  const content = readText(file);
  if (content === undefined) return [];
  const sessionId = sessionIdOf(file);
  let fallback = 0;
  try {
    fallback = Math.floor(statSync(file).mtimeMs);
  } catch {}
  let model: string | undefined;
  let provider: string | undefined;
  const out: ClawEntry[] = [];
  for (const raw of content.split("\n")) {
    if (!raw.includes('"model_change"') && !raw.includes('"model-snapshot"') && !raw.includes('"usage"')) continue;
    const line = parseLine(raw);
    if (!line) continue;
    if (isModelChange(line)) {
      const [m, p] = modelChange(line);
      if (m !== undefined) model = m;
      if (p !== undefined) provider = p;
      continue;
    }
    const entry = transcriptEntry(line, sessionId, model, provider, fallback, false);
    if (entry) out.push(entry);
  }
  return out;
};

const readAgentDatabase = async (path: string, debug: (message: string) => void): Promise<ClawEntry[]> => {
  const db = await openReadonly(path);
  if (!db) {
    debug(`Failed to open OpenClaw agent database: ${path}`);
    return [];
  }
  let rows: Record<string, unknown>[] = [];
  try {
    if (db.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transcript_events' LIMIT 1").length === 0) {
      debug(`OpenClaw agent database has no transcript_events table: ${path}`);
      return [];
    }
    rows = db.all("SELECT session_id, seq, event_json, created_at FROM transcript_events ORDER BY session_id ASC, seq ASC");
  } catch {
    debug(`Failed to read OpenClaw agent database: ${path}`);
    return [];
  } finally {
    db.close();
  }
  let session: string | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  const out: ClawEntry[] = [];
  for (const row of rows) {
    const sessionId = sqlText(row.session_id);
    if (sessionId === undefined) continue;
    if (session !== sessionId) {
      session = sessionId;
      model = undefined;
      provider = undefined;
    }
    const fallback = Math.max(sqlInt(row.created_at) ?? 0, 0);
    const json = sqlText(row.event_json);
    if (json === undefined) continue;
    const line = parseLine(json);
    if (!line) continue;
    if (isModelChange(line)) {
      const [m, p] = modelChange(line);
      if (m !== undefined) model = m;
      if (p !== undefined) provider = p;
      continue;
    }
    const entry = transcriptEntry(line, sessionId, model, provider, fallback, true);
    if (entry) out.push(entry);
  }
  return out;
};

const strip = ({ messageId: _m, migrationId: _g, entryId: _e, ...entry }: ClawEntry): UsageEntry => entry;

export const openclaw: Adapter = {
  id: "openclaw",
  label: "OpenClaw",
  product: "OpenClaw",
  envVars: ["OPENCLAW_DIR"],
  reports: ["daily", "monthly", "session"],
  sessionStyle: "entries-with-activity",
  hasData: () => openclawRoots().some((root) => sessionFiles(root).length > 0 || agentDatabases(root).length > 0),
  async load(ctx): Promise<UsageEntry[]> {
    const debug = (message: string) => {
      if (ctx.debug) ctx.warn(message);
    };
    const entries: ClawEntry[] = [];
    const seen = new Set<string>();
    const sqliteEntries: ClawEntry[] = [];
    for (const root of openclawRoots()) {
      for (const path of agentDatabases(root)) sqliteEntries.push(...(await readAgentDatabase(path, debug)));
      for (const file of sessionFiles(root)) {
        for (const entry of parseSessionFile(file)) {
          if (seen.has(entry.entryId)) continue;
          seen.add(entry.entryId);
          entries.push(entry);
        }
      }
    }
    const sqliteIds = new Set<string>();
    for (const entry of sqliteEntries) {
      if (entry.messageId === undefined) {
        if (!seen.has(entry.entryId)) {
          seen.add(entry.entryId);
          entries.push(entry);
        }
        continue;
      }
      const sqliteId = `openclaw:${entry.sessionId}:${entry.messageId}`;
      if (sqliteIds.has(sqliteId)) continue;
      sqliteIds.add(sqliteId);
      let position = entries.findIndex((e) => e.sessionId === entry.sessionId && e.messageId === entry.messageId);
      if (position < 0) position = entries.findIndex((e) => e.migrationId === entry.migrationId);
      if (position >= 0) entries[position] = entry;
      else {
        seen.add(entry.entryId);
        entries.push(entry);
      }
    }
    return entries.map(strip).sort((a, b) => a.timestamp - b.timestamp);
  },
};
