import type { ModelBreakdown, UsageSummary } from "../core/types.ts";
import type { AllRow } from "../report/unified.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };

const COST_KEYS = new Set(["totalCost", "costUSD", "cost"]);

export const stripCosts = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(stripCosts);
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value)) {
      if (COST_KEYS.has(key) || child === undefined) continue;
      out[key] = stripCosts(child);
    }
    return out;
  }
  return value;
};

const sortKeys = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) out[key] = sortKeys(child);
    }
    return out;
  }
  return value;
};

export const renderJson = (value: Json, options: { noCost: boolean; sorted?: boolean }): string => {
  let out = options.noCost ? stripCosts(value) : value;
  if (options.sorted !== false) out = sortKeys(out);
  return JSON.stringify(out, null, 2);
};

export const breakdownJson = (b: ModelBreakdown): Json => ({
  modelName: b.modelName,
  inputTokens: b.inputTokens,
  outputTokens: b.outputTokens,
  cacheCreationTokens: b.cacheCreationTokens,
  cacheReadTokens: b.cacheReadTokens,
  cost: b.cost,
  missingPricing: b.missingPricing ? true : undefined,
});

const summaryTotal = (s: UsageSummary) => s.inputTokens + s.outputTokens + s.cacheCreationTokens + s.cacheReadTokens + s.extraTotalTokens;

export const summaryJson = (row: UsageSummary): Json => ({
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheCreationTokens: row.cacheCreationTokens,
  cacheReadTokens: row.cacheReadTokens,
  totalTokens: summaryTotal(row),
  totalCost: row.totalCost,
  modelsUsed: row.modelsUsed,
  modelBreakdowns: row.modelBreakdowns.map(breakdownJson),
  date: row.date,
  month: row.month,
  week: row.week,
  credits: row.credits,
});

export const genericSessionJson = (row: UsageSummary, withActivity: boolean): Json => ({
  sessionId: row.sessionId ?? null,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheCreationTokens: row.cacheCreationTokens,
  cacheReadTokens: row.cacheReadTokens,
  totalTokens: summaryTotal(row),
  totalCost: row.totalCost,
  modelsUsed: row.modelsUsed,
  modelBreakdowns: row.modelBreakdowns.map(breakdownJson),
  credits: row.credits,
  lastActivity: withActivity ? (row.lastActivity ?? null) : undefined,
  firstActivity: withActivity ? (row.firstActivity ?? null) : undefined,
  projectPath: withActivity ? (row.projectPath ?? null) : undefined,
});

export const sessionSummaryJson = (row: UsageSummary): Json => ({
  sessionId: row.sessionId ?? null,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheCreationTokens: row.cacheCreationTokens,
  cacheReadTokens: row.cacheReadTokens,
  totalTokens: summaryTotal(row),
  totalCost: row.totalCost,
  lastActivity: row.lastActivity ?? null,
  firstActivity: row.firstActivity ?? null,
  modelsUsed: row.modelsUsed,
  modelBreakdowns: row.modelBreakdowns.map(breakdownJson),
  projectPath: row.projectPath ?? null,
  credits: row.credits,
});

const unpriced = (breakdowns: ModelBreakdown[]): string[] =>
  [...new Set(breakdowns.filter((b) => b.missingPricing).map((b) => b.modelName))].sort();

export const totalsJson = (rows: UsageSummary[]): Json => {
  const sum = (f: (r: UsageSummary) => number) => rows.reduce((acc, r) => acc + f(r), 0);
  const input = sum((r) => r.inputTokens);
  const output = sum((r) => r.outputTokens);
  const cacheCreate = sum((r) => r.cacheCreationTokens);
  const cacheRead = sum((r) => r.cacheReadTokens);
  const extra = sum((r) => r.extraTotalTokens);
  const credits = sum((r) => r.credits ?? 0);
  const models = unpriced(rows.flatMap((r) => r.modelBreakdowns));
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreate,
    cacheReadTokens: cacheRead,
    totalTokens: input + output + cacheCreate + cacheRead + extra,
    totalCost: sum((r) => r.totalCost),
    credits: credits > 0 ? credits : undefined,
    unpricedModels: models.length ? models : undefined,
  };
};

export const agentJson = (row: AllRow): Record<string, Json | undefined> => ({
  agent: row.agent,
  modelsUsed: row.modelsUsed,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheCreationTokens: row.cacheCreationTokens,
  cacheReadTokens: row.cacheReadTokens,
  totalTokens: row.totalTokens,
  totalCost: row.totalCost,
  modelBreakdowns: row.modelBreakdowns.map(breakdownJson),
});

export const allRowJson = (row: AllRow, includeAgents: boolean): Json => {
  const value = agentJson(row);
  value.period = row.period;
  if (row.metadataAgents) value.metadata = (row.metadata as Json) ?? { agents: row.metadataAgents };
  else if (row.metadata) value.metadata = row.metadata as Json;
  if (includeAgents && row.agentBreakdowns) value.agents = row.agentBreakdowns.map(agentJson);
  return value;
};

export const allTotalsJson = (rows: AllRow[]): Json => {
  const sum = (f: (r: AllRow) => number) => rows.reduce((acc, r) => acc + f(r), 0);
  const models = unpriced(rows.flatMap((r) => r.modelBreakdowns));
  return {
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    cacheCreationTokens: sum((r) => r.cacheCreationTokens),
    cacheReadTokens: sum((r) => r.cacheReadTokens),
    totalTokens: sum((r) => r.totalTokens),
    totalCost: sum((r) => r.totalCost),
    unpricedModels: models.length ? models : undefined,
  };
};
