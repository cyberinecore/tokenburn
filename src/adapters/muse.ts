import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { envPaths, home, isDir, listDir, walk } from "../core/fs.ts";
import { openReadonly } from "../core/sqlite.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";

const USAGE_METHOD = Buffer.from('{"method":"session/tokenUsage"');
const SOURCE_RECORD =
  /\\?"id\\?":\\?"([0-9a-f-]{36})\\?",\\?"stream\\?":\{[^}]*\},\\?"sequence\\?":(\d+),\\?"recorded_at\\?":(\d+)/g;

type Obj = Record<string, any>;

type UsageRecord = {
  sessionId?: string;
  turnId?: string;
  modelId?: string | null;
  promptTokens?: number;
  totalTokens?: number;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cachedTokens?: number; reasoningTokens?: number };
  sourceRange?: { first?: { id?: string; sequence?: number } };
};

export const museRoots = (): string[] => {
  if (process.env.MUSE_DATA_DIR !== undefined) return [...new Set(envPaths("MUSE_DATA_DIR"))].filter(isDir);
  const xdg = process.env.XDG_DATA_HOME?.startsWith("/") ? process.env.XDG_DATA_HOME : join(home(), ".local", "share");
  const dir = join(xdg, "muse");
  return isDir(dir) ? [dir] : [];
};

const uint = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);

export const readJournalUsage = (file: string): UsageRecord[] => {
  let buffer: Buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  let from = 0;
  for (;;) {
    const at = buffer.indexOf(USAGE_METHOD, from);
    if (at < 0) break;
    from = at + USAGE_METHOD.length;
    if (at < 4) continue;
    const length = buffer.readUInt32LE(at - 4);
    if (length <= 0 || at + length > buffer.length) continue;
    try {
      const value = JSON.parse(buffer.toString("utf8", at, at + length)) as { params?: UsageRecord };
      if (value.params) out.push(value.params);
      from = at + length;
    } catch {}
  }
  return out;
};

const sourceTimestamps = (logFile: string | undefined): Map<string, number> => {
  const map = new Map<string, number>();
  if (!logFile) return map;
  let text: string;
  try {
    text = readFileSync(logFile, "utf8");
  } catch {
    return map;
  }
  for (const match of text.matchAll(SOURCE_RECORD)) map.set(match[1]!, Math.floor(Number(match[3]) / 1000));
  return map;
};

const snapshotInfo = (dir: string): { turns: Map<string, number>; last?: number; workspace?: string } => {
  const turns = new Map<string, number>();
  const snapshot = listDir(dir)
    .filter((name) => name.startsWith("snapshot-") && name.endsWith(".json"))
    .sort()[0];
  if (!snapshot) return { turns };
  try {
    const value = JSON.parse(readFileSync(join(dir, snapshot), "utf8")) as Obj;
    const continuation = value.continuation ?? {};
    for (const [turnId, item] of Object.entries((continuation.user_items ?? {}) as Obj)) {
      const ms = Date.parse((item as Obj)?.recordedAt);
      if (!Number.isNaN(ms)) turns.set(turnId, ms);
    }
    const last = Date.parse(continuation.last_identity?.recorded_at);
    const workspace = continuation.state?.branch?.workspaceRoot;
    return { turns, last: Number.isNaN(last) ? undefined : last, workspace: typeof workspace === "string" ? workspace : undefined };
  } catch {
    return { turns };
  }
};

type IndexRow = { workspace?: string; model?: string; logPath?: string; updatedAt?: number };

const loadIndex = async (root: string): Promise<Map<string, IndexRow>> => {
  const map = new Map<string, IndexRow>();
  const db = await openReadonly(join(root, "session-index.db"));
  if (!db) return map;
  try {
    for (const row of db.all("SELECT session_id, workspace_root, model_id, session_log_path, updated_at_us FROM sessions")) {
      if (typeof row.session_id !== "string") continue;
      map.set(row.session_id, {
        workspace: typeof row.workspace_root === "string" ? row.workspace_root : undefined,
        model: typeof row.model_id === "string" && row.model_id ? row.model_id : undefined,
        logPath: typeof row.session_log_path === "string" ? row.session_log_path : undefined,
        updatedAt: typeof row.updated_at_us === "number" ? Math.floor(row.updated_at_us / 1000) : undefined,
      });
    }
  } catch {
  } finally {
    db.close();
  }
  return map;
};

const sessionLogs = (root: string): Map<string, string> => {
  const map = new Map<string, string>();
  const sessions = join(root, "sessions");
  for (const year of listDir(sessions)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const file of walk(join(sessions, year), (name) => name === "session.jsonl")) map.set(basename(dirname(file)), file);
  }
  return map;
};

const mtime = (file: string): number => {
  try {
    return Math.floor(statSync(file).mtimeMs);
  } catch {
    return 0;
  }
};

export const muse: Adapter = {
  id: "muse",
  label: "Muse Code",
  product: "Muse Code",
  envVars: ["MUSE_DATA_DIR"],
  reports: ["daily", "weekly", "monthly", "session"],
  hasData: () => museRoots().some((root) => listDir(join(root, "sessions", ".msp-view-v1")).length > 0),
  async load(): Promise<UsageEntry[]> {
    const entries: UsageEntry[] = [];
    const seen = new Set<string>();
    for (const root of museRoots()) {
      const viewRoot = join(root, "sessions", ".msp-view-v1");
      const index = await loadIndex(root);
      const logs = sessionLogs(root);
      for (const sessionDir of listDir(viewRoot).sort()) {
        const dir = join(viewRoot, sessionDir);
        const journals = listDir(dir)
          .filter((name) => name.startsWith("journal-") && name.endsWith(".bin"))
          .sort();
        if (journals.length === 0) continue;
        const records = journals.flatMap((name) => readJournalUsage(join(dir, name)));
        if (records.length === 0) continue;
        const indexRow = index.get(sessionDir);
        const sources = sourceTimestamps(logs.get(sessionDir) ?? indexRow?.logPath);
        const snapshot = snapshotInfo(dir);
        const fallback = snapshot.last ?? indexRow?.updatedAt ?? mtime(join(dir, journals[journals.length - 1]!));
        for (const record of records) {
          const usage = record.usage ?? {};
          const cacheRead = uint(usage.cacheReadTokens ?? usage.cachedTokens);
          const rawInput = uint(usage.inputTokens ?? record.promptTokens);
          const output = uint(usage.outputTokens ?? Math.max(uint(record.totalTokens) - uint(record.promptTokens), 0));
          const cacheWrite = uint(usage.cacheWriteTokens);
          const input = Math.max(rawInput - cacheRead - cacheWrite, 0);
          if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) continue;
          const sourceId = record.sourceRange?.first?.id;
          const sessionId = record.sessionId ?? sessionDir;
          const key = `${sessionId}\u0000${sourceId ?? `${record.turnId}:${rawInput}:${output}:${cacheRead}`}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const timestamp = (sourceId && sources.get(sourceId)) || (record.turnId && snapshot.turns.get(record.turnId)) || fallback;
          entries.push({
            agent: "muse",
            timestamp,
            sessionId,
            projectPath: indexRow?.workspace ?? snapshot.workspace ?? "Muse Code",
            model: (typeof record.modelId === "string" && record.modelId) || indexRow?.model || "unknown",
            inputTokens: input,
            outputTokens: output,
            cacheCreationTokens: cacheWrite,
            cacheReadTokens: cacheRead,
            extraTotalTokens: 0,
            reasoningOutputTokens: uint(usage.reasoningTokens),
          });
        }
      }
    }
    return entries.sort((a, b) => a.timestamp - b.timestamp);
  },
};
