import { realpathSync } from "node:fs";
import { join } from "node:path";
import { home, isDir } from "../core/fs.ts";
import { openReadonly } from "../core/sqlite.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { applyTotalTokenFallback } from "../core/tokens.ts";
import { isFile, sqlText } from "./common.ts";

const canonical = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

const roots = (): string[] => {
  const raw = process.env.ZCODE_HOME;
  const configured =
    raw === undefined
      ? []
      : raw
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
  const candidates = configured.length ? configured : [join(home(), ".zcode")];
  return [...new Set(candidates.filter(isDir).map(canonical).filter((p): p is string => Boolean(p)))];
};

export const zcodeDbPaths = (): string[] =>
  [
    ...new Set(
      roots()
        .map((root) => canonical(join(root, "cli/db/db.sqlite")))
        .filter((p): p is string => Boolean(p)),
    ),
  ].filter(isFile);

const REQUIRED_MODEL = ["id", "session_id", "started_at", "model_id", "status", "input_tokens", "output_tokens"];
const REQUIRED_SESSION = ["id", "directory"];

const tokenColumn = (value: unknown): number => {
  if (typeof value === "bigint") return Number(value > 0n ? value : 0n);
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Number.isInteger(value) ? Math.max(value, 0) : value > 0 ? Math.round(value) : 0;
};

const timestampColumn = (value: unknown): number | undefined => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.round(value);
};

const optText = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const isZaiProvider = (provider: string | undefined) =>
  provider !== undefined && ["zai", "z.ai", "zai-coding-plan", "builtin:zai-coding-plan", "builtin:bigmodel-coding-plan"].includes(provider.trim().toLowerCase());

const isZaiModel = (model: string) => model.startsWith("glm-") || model.startsWith("glm/");

const rowEntry = (row: Record<string, unknown>): (UsageEntry & { id: string }) | undefined => {
  const id = sqlText(row.id);
  const sessionId = sqlText(row.session_id);
  const startedAt = timestampColumn(row.started_at);
  const modelId = sqlText(row.model_id);
  if (id === undefined || sessionId === undefined || startedAt === undefined || modelId === undefined) return undefined;
  if (!id.trim() || !sessionId.trim() || !modelId.trim() || startedAt <= 0) return undefined;
  const input = tokenColumn(row.input_tokens);
  const cacheRead = Math.min(tokenColumn(row.cache_read), input);
  const cacheCreation = Math.min(tokenColumn(row.cache_creation), Math.max(input - cacheRead, 0));
  const { usage, extra } = applyTotalTokenFallback(
    { input: Math.max(input - cacheRead - cacheCreation, 0), output: tokenColumn(row.output_tokens), cacheCreation, cacheRead },
    0,
    tokenColumn(row.computed_total),
  );
  if (usage.input + usage.output + usage.cacheCreation + usage.cacheRead === 0 && extra === 0) return undefined;
  const model = modelId.trim();
  const lower = model.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const provider = optText(row.provider_id);
  const zai = isZaiProvider(provider) || (provider === undefined && isZaiModel(lower));
  const candidates = [...new Set([model, lower, ...(zai ? [`zai/${model}`, `zai/${lower}`] : [])])];
  const priced = provider !== undefined && !isZaiProvider(provider) ? [] : [...candidates.filter((c) => c.startsWith("zai/")), ...candidates.filter((c) => !c.startsWith("zai/"))];
  const directory = optText(row.directory);
  return {
    agent: "zcode",
    timestamp: startedAt,
    sessionId,
    projectPath: directory && directory.trim() ? directory : "ZCode",
    model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheCreationTokens: usage.cacheCreation,
    cacheReadTokens: usage.cacheRead,
    extraTotalTokens: extra,
    extraBilledAsOutput: true,
    cacheCreationBilledAsInput: zai,
    version: optText(row.version),
    overridePricingCandidates: candidates,
    pricingCandidates: priced,
    candidateRule: "first-found",
    id,
  };
};

export const zcode: Adapter = {
  id: "zcode",
  label: "ZCode",
  product: "ZCode",
  envVars: ["ZCODE_HOME"],
  reports: ["daily", "monthly", "session"],
  sessionStyle: "entries-with-activity",
  hasData: () => zcodeDbPaths().length > 0,
  async load(ctx): Promise<UsageEntry[]> {
    const debug = (message: string) => {
      if (ctx.debug) ctx.warn(message);
    };
    const seen = new Set<string>();
    const entries: UsageEntry[] = [];
    for (const path of zcodeDbPaths()) {
      const db = await openReadonly(path);
      if (!db) {
        debug(`Failed to open ZCode database: ${path}`);
        continue;
      }
      let rows: Record<string, unknown>[] = [];
      try {
        const columns = (table: string) => new Set(db.all(`PRAGMA table_info("${table}")`).map((r) => String(r.name)));
        const model = columns("model_usage");
        const session = columns("session");
        const missing = [...REQUIRED_MODEL.filter((c) => !model.has(c)), ...REQUIRED_SESSION.filter((c) => !session.has(c))];
        if (missing.length) {
          debug(`Unsupported ZCode SQLite schema at ${path}: missing ${missing.join(", ")}`);
          continue;
        }
        const cacheCreation = model.has("cache_creation_input_tokens") ? "m.cache_creation_input_tokens" : "0";
        const cacheRead = model.has("cache_read_input_tokens") ? "m.cache_read_input_tokens" : "0";
        const total = model.has("computed_total_tokens") ? "m.computed_total_tokens" : "m.input_tokens + m.output_tokens";
        const provider = model.has("provider_id") ? "m.provider_id" : "NULL";
        const version = session.has("version") ? "s.version" : "NULL";
        rows = db.all(
          `SELECT m.id AS id, m.session_id AS session_id, m.started_at AS started_at, m.model_id AS model_id, m.input_tokens AS input_tokens, m.output_tokens AS output_tokens, ${cacheCreation} AS cache_creation, ${cacheRead} AS cache_read, ${total} AS computed_total, ${provider} AS provider_id, s.directory AS directory, ${version} AS version FROM model_usage m LEFT JOIN session s ON s.id = m.session_id WHERE m.status = 'completed'`,
        );
      } catch (error) {
        debug(`Failed to read ZCode database ${path}: ${(error as Error).message}`);
      } finally {
        db.close();
      }
      for (const row of rows) {
        const parsed = rowEntry(row);
        if (!parsed) continue;
        const { id, ...entry } = parsed;
        if (seen.has(id)) continue;
        seen.add(id);
        entries.push(entry);
      }
    }
    return entries.sort((a, b) => a.timestamp - b.timestamp);
  },
};
