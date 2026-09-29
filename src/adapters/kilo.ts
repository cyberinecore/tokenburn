import { join } from "node:path";
import { openReadonly } from "../core/sqlite.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { byTimestamp, envOrDefaultDirs, isFile, isObj, nonEmpty, type Obj, sqlText, tokenEntry, u64 } from "./common.ts";

export const kiloDbPaths = (): string[] =>
  envOrDefaultDirs("KILO_DATA_DIR", (h) => [join(h, ".local", "share", "kilo")])
    .map((dir) => join(dir, "kilo.db"))
    .filter(isFile);

const normalizeTimestamp = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value < 1_000_000_000_000 ? value * 1000 : value;
};

const messageEntry = (value: Obj, rowId: string, rowSessionId: string, dbPath: string): (UsageEntry & { id: string }) | undefined => {
  if (value.role !== "assistant" || !isObj(value.tokens)) return undefined;
  const tokens = value.tokens;
  const cache = isObj(tokens.cache) ? tokens.cache : undefined;
  const model = nonEmpty(value.modelID);
  const timestamp = normalizeTimestamp(isObj(value.time) ? value.time.created : undefined);
  const provider = nonEmpty(value.providerID)?.replaceAll("-", "_");
  const entry = tokenEntry(
    {
      agent: "kilo",
      timestamp: timestamp ?? 0,
      sessionId: nonEmpty(value.session_id) ?? rowSessionId,
      projectPath: "Kilo",
      model,
      extraBilledAsOutput: true,
      costUSD: typeof value.cost === "number" && Number.isFinite(value.cost) ? value.cost : undefined,
      exactPricingCandidates: model && provider && provider !== "unknown" && provider !== "kilo" ? [`${provider}/${model}`] : undefined,
      pricingCandidates: model ? [model] : undefined,
      candidateRule: "first-found",
    },
    { input: u64(tokens.input), output: u64(tokens.output), cacheCreation: u64(cache?.write), cacheRead: u64(cache?.read) },
    u64(tokens.total),
    u64(tokens.reasoning),
  );
  if (!entry || model === undefined || timestamp === undefined) return undefined;
  return { ...entry, id: nonEmpty(value.id) ?? `${dbPath}:${rowId}` };
};

export const kilo: Adapter = {
  id: "kilo",
  label: "Kilo",
  product: "Kilo CLI",
  envVars: ["KILO_DATA_DIR"],
  reports: ["daily", "monthly", "session"],
  hasData: () => kiloDbPaths().length > 0,
  async load(ctx): Promise<UsageEntry[]> {
    const seen = new Set<string>();
    const entries: UsageEntry[] = [];
    for (const path of kiloDbPaths()) {
      const db = await openReadonly(path);
      if (!db) continue;
      let rows: Record<string, unknown>[] = [];
      try {
        rows = db.all("SELECT id, session_id, data FROM message");
      } catch (error) {
        if (ctx.debug) ctx.warn(`Failed to read Kilo database ${path}: ${(error as Error).message}`);
      } finally {
        db.close();
      }
      for (const row of rows) {
        const rowId = sqlText(row.id);
        const rowSessionId = sqlText(row.session_id);
        const data = sqlText(row.data);
        if (rowId === undefined || rowSessionId === undefined || data === undefined) continue;
        let value: unknown;
        try {
          value = JSON.parse(data);
        } catch {
          continue;
        }
        if (!isObj(value)) continue;
        const parsed = messageEntry(value, rowId, rowSessionId, path);
        if (!parsed) continue;
        const { id, ...entry } = parsed;
        if (seen.has(id)) continue;
        seen.add(id);
        entries.push(entry);
      }
    }
    return entries.sort(byTimestamp);
  },
};
