import { join } from "node:path";
import { envPaths, home } from "../core/fs.ts";
import { openReadonly } from "../core/sqlite.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { byTimestamp, isFile } from "./common.ts";

export const hermesStateDbs = (): string[] => {
  const homes = process.env.HERMES_HOME !== undefined ? envPaths("HERMES_HOME") : [join(home(), ".hermes")];
  return [...new Set(homes.map((h) => join(h, "state.db")))].filter(isFile);
};

const QUERY = `
  SELECT id, model, billing_provider, started_at, message_count, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd
  FROM sessions
  WHERE model IS NOT NULL AND TRIM(model) != ''
`;

const num = (value: unknown): number | undefined => {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const u64 = (value: unknown): number => {
  const n = num(value);
  return n === undefined ? 0 : Math.max(Math.trunc(n), 0);
};

const inferProvider = (model: string): string => {
  const m = model.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (m.startsWith("claude-") || m.startsWith("claude/")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("chatgpt") || /^o\d/.test(m)) return "openai";
  if (m.startsWith("gemini-") || m.startsWith("gemini/")) return "google";
  return "hermes";
};

const normalizeProvider = (value: unknown, model: string): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return inferProvider(model);
  const normalized = trimmed.replace(/[A-Z]/g, (c) => c.toLowerCase()).replaceAll("-", "_");
  if (normalized === "anthropic" || normalized === "claude") return "anthropic";
  if (normalized === "openai" || normalized === "openai_codex") return "openai";
  if (["google", "google_ai", "gemini", "vertex", "vertex_ai"].includes(normalized)) return "google";
  return normalized;
};

const rowEntry = (row: Record<string, unknown>): UsageEntry | undefined => {
  if (typeof row.id !== "string" || typeof row.model !== "string") return undefined;
  const sessionId = row.id;
  const model = row.model.trim();
  if (!sessionId || !model) return undefined;
  const started = num(row.started_at);
  if (started === undefined) return undefined;
  const millis = started > 1e12 ? started : started * 1000;
  if (!(millis > 0)) return undefined;
  const input = u64(row.input_tokens);
  const output = u64(row.output_tokens);
  const cacheRead = u64(row.cache_read_tokens);
  const cacheCreation = u64(row.cache_write_tokens);
  const reasoning = u64(row.reasoning_tokens);
  const nonNegative = (v: unknown) => {
    const n = num(v);
    return n === undefined ? undefined : Math.max(n, 0);
  };
  const cost = nonNegative(row.actual_cost_usd) ?? nonNegative(row.estimated_cost_usd);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0 && reasoning === 0 && (cost ?? 0) === 0) return undefined;
  const provider = normalizeProvider(row.billing_provider, model);
  return {
    agent: "hermes",
    timestamp: Math.trunc(millis),
    sessionId,
    projectPath: "Hermes",
    model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    extraTotalTokens: reasoning,
    extraBilledAsOutput: true,
    messageCount: u64(row.message_count),
    costUSD: cost !== undefined && cost > 0 ? cost : undefined,
    exactPricingCandidates: provider !== "hermes" ? [`${provider}/${model}`] : undefined,
    pricingCandidates: [model],
  };
};

export const hermes: Adapter = {
  id: "hermes",
  label: "Hermes",
  product: "Hermes Agent",
  envVars: ["HERMES_HOME"],
  reports: ["daily", "monthly", "session"],
  hasData: () => hermesStateDbs().length > 0,
  async load(ctx): Promise<UsageEntry[]> {
    const seen = new Set<string>();
    const entries: UsageEntry[] = [];
    for (const path of hermesStateDbs()) {
      const db = await openReadonly(path);
      if (!db) continue;
      let rows: Record<string, unknown>[] = [];
      try {
        rows = db.all(QUERY);
      } catch (error) {
        if (ctx.debug) ctx.warn(`Failed to read Hermes state database ${path}: ${(error as Error).message}`);
      } finally {
        db.close();
      }
      for (const row of rows) {
        const entry = rowEntry(row);
        if (!entry || seen.has(entry.sessionId)) continue;
        seen.add(entry.sessionId);
        entries.push(entry);
      }
    }
    return entries.sort(byTimestamp);
  },
};
