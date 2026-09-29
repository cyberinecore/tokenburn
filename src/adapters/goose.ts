import { realpathSync } from "node:fs";
import { join } from "node:path";
import { home } from "../core/fs.ts";
import { openReadonly } from "../core/sqlite.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { byTimestamp, isFile, isObj, nonEmpty, parseTsTimestamp, sqlInt, sqlText } from "./common.ts";

const DB_FILE = "sessions.db";

const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export const gooseDbPaths = (): string[] => {
  const root = process.env.GOOSE_PATH_ROOT?.trim();
  const candidates = root
    ? [join(root, "data", "sessions", DB_FILE)]
    : [
        join(home(), ".local/share/goose/sessions", DB_FILE),
        join(home(), "Library/Application Support/goose/sessions", DB_FILE),
        join(home(), ".local/share/Block/goose/sessions", DB_FILE),
      ];
  return [...new Set(candidates.map(canonical))].filter(isFile);
};

const QUERY = `
  SELECT id, model_config_json, provider_name, created_at, total_tokens, input_tokens, output_tokens,
         accumulated_total_tokens, accumulated_input_tokens, accumulated_output_tokens
  FROM sessions
  WHERE model_config_json IS NOT NULL AND TRIM(model_config_json) != ''
`;

const positive = (value: unknown): number | undefined => {
  const n = sqlInt(value);
  return n !== undefined && n > 0 ? n : undefined;
};

const parseGooseTimestamp = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^[-+]?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    const millis = n > 1_000_000_000_000 ? n : n * 1000;
    return millis > 0 ? millis : undefined;
  }
  const direct = parseTsTimestamp(trimmed);
  if (direct !== undefined) return direct;
  if (trimmed.length === 19 && trimmed[4] === "-" && trimmed[7] === "-" && (trimmed[10] === " " || trimmed[10] === "T"))
    return parseTsTimestamp(`${trimmed.slice(0, 10)}T${trimmed.slice(11)}Z`);
  if (trimmed.length === 10 && trimmed[4] === "-" && trimmed[7] === "-") return parseTsTimestamp(`${trimmed}T00:00:00Z`);
  return undefined;
};

const modelName = (config: string): string | undefined => {
  try {
    const value = JSON.parse(config);
    return isObj(value) ? nonEmpty(value.model_name) : undefined;
  } catch {
    return undefined;
  }
};

const normalizeProvider = (provider: string | undefined, model: string): string => {
  const trimmed = provider?.trim();
  if (trimmed) return trimmed.replaceAll("-", "_");
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("chatgpt-") || model.startsWith("o")) return "openai";
  if (model.startsWith("gemini-")) return "google";
  if (model.toLowerCase().startsWith("qwen")) return "openrouter";
  return "goose";
};

const rowEntry = (row: Record<string, unknown>): UsageEntry | undefined => {
  const id = sqlText(row.id);
  const config = sqlText(row.model_config_json);
  if (id === undefined || config === undefined) return undefined;
  const created = sqlText(row.created_at);
  const timestamp = created === undefined ? undefined : parseGooseTimestamp(created);
  if (timestamp === undefined) return undefined;
  const model = modelName(config);
  if (model === undefined) return undefined;
  const input = positive(row.accumulated_input_tokens) ?? positive(row.input_tokens) ?? 0;
  const output = positive(row.accumulated_output_tokens) ?? positive(row.output_tokens) ?? 0;
  const total = positive(row.accumulated_total_tokens) ?? positive(row.total_tokens) ?? input + output;
  if (input === 0 && output === 0 && total === 0) return undefined;
  const provider = normalizeProvider(sqlText(row.provider_name), model);
  return {
    agent: "goose",
    timestamp,
    sessionId: id,
    projectPath: "Goose",
    model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    extraTotalTokens: Math.max(total - (input + output), 0),
    extraBilledAsOutput: true,
    pricingCandidates: provider === "goose" ? [model] : [model, `${provider}/${model}`],
  };
};

export const goose: Adapter = {
  id: "goose",
  label: "Goose",
  product: "Goose",
  envVars: ["GOOSE_PATH_ROOT"],
  reports: ["daily", "monthly", "session"],
  hasData: () => gooseDbPaths().length > 0,
  async load(ctx): Promise<UsageEntry[]> {
    const seen = new Set<string>();
    const entries: UsageEntry[] = [];
    for (const path of gooseDbPaths()) {
      const db = await openReadonly(path);
      if (!db) continue;
      let rows: Record<string, unknown>[] = [];
      try {
        rows = db.all(QUERY);
      } catch (error) {
        if (ctx.debug) ctx.warn(`Failed to read Goose database ${path}: ${(error as Error).message}`);
      } finally {
        db.close();
      }
      for (const row of rows) {
        const entry = rowEntry(row);
        if (!entry) continue;
        const key = `${path}:${entry.sessionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
      }
    }
    return entries.sort(byTimestamp);
  },
};
