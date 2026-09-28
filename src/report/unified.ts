import type { ModelBreakdown, ReportKind, SortOrder, UsageSummary } from "../core/types.ts";
import { compareStrings, periodOf } from "./summary.ts";
import { weekStart } from "../core/dates.ts";

export type AllRow = {
  period: string;
  agent: string;
  modelsUsed: string[];
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  metadata?: Record<string, unknown>;
  metadataAgents?: string[];
  agentBreakdowns?: AllRow[];
  modelBreakdowns: ModelBreakdown[];
};

const byCostDesc = (a: ModelBreakdown, b: ModelBreakdown) => b.cost - a.cost;

const mergeBreakdowns = (lists: ModelBreakdown[][], sort: boolean): ModelBreakdown[] => {
  const indexes = new Map<string, number>();
  const out: ModelBreakdown[] = [];
  for (const list of lists) {
    for (const item of list) {
      let index = indexes.get(item.modelName);
      if (index === undefined) {
        index = out.length;
        indexes.set(item.modelName, index);
        out.push({ ...item, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, extraTotalTokens: 0, cost: 0, missingPricing: false });
      }
      const b = out[index]!;
      b.inputTokens += item.inputTokens;
      b.outputTokens += item.outputTokens;
      b.cacheCreationTokens += item.cacheCreationTokens;
      b.cacheReadTokens += item.cacheReadTokens;
      b.extraTotalTokens += item.extraTotalTokens;
      b.cost += item.cost;
      b.missingPricing ||= item.missingPricing;
    }
  }
  if (sort) out.sort(byCostDesc);
  return out;
};

const summaryTotal = (s: UsageSummary) => s.inputTokens + s.outputTokens + s.cacheCreationTokens + s.cacheReadTokens + s.extraTotalTokens;

export const summaryRows = (agent: string, summaries: UsageSummary[]): AllRow[] => {
  const rows: AllRow[] = [];
  for (const summary of summaries) {
    const period = periodOf(summary);
    if (!period) continue;
    const totalTokens = summaryTotal(summary);
    if (totalTokens === 0) continue;
    const metadata: Record<string, unknown> = {};
    if (summary.credits !== undefined) metadata.credits = summary.credits;
    if (summary.sessionId !== undefined && summary.lastActivity) metadata.lastActivity = summary.lastActivity;
    if (summary.sessionId !== undefined && summary.reasoningOutputTokens !== undefined) metadata.reasoningOutputTokens = summary.reasoningOutputTokens;
    rows.push({
      period,
      agent,
      modelsUsed: summary.modelsUsed,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      cacheCreationTokens: summary.cacheCreationTokens,
      cacheReadTokens: summary.cacheReadTokens,
      totalTokens,
      totalCost: summary.totalCost,
      metadata: Object.keys(metadata).length ? metadata : undefined,
      metadataAgents: [agent],
      modelBreakdowns: summary.modelBreakdowns,
    });
  }
  return rows;
};

class AllAccumulator {
  inputTokens = 0;
  outputTokens = 0;
  cacheCreationTokens = 0;
  cacheReadTokens = 0;
  totalTokens = 0;
  totalCost = 0;
  models = new Set<string>();
  agents = new Set<string>();
  breakdowns: AllRow[] = [];
  indexes = new Map<string, number>();

  add(row: AllRow): void {
    this.inputTokens += row.inputTokens;
    this.outputTokens += row.outputTokens;
    this.cacheCreationTokens += row.cacheCreationTokens;
    this.cacheReadTokens += row.cacheReadTokens;
    this.totalTokens += row.totalTokens;
    this.totalCost += row.totalCost;
    for (const model of row.modelsUsed) this.models.add(model);
    if (row.metadataAgents) for (const agent of row.metadataAgents) this.agents.add(agent);
    else if (row.agent !== "all") this.agents.add(row.agent);
    const index = this.indexes.get(row.agent);
    if (index === undefined) {
      this.indexes.set(row.agent, this.breakdowns.length);
      this.breakdowns.push({ ...row, modelsUsed: [...row.modelsUsed], metadataAgents: [row.agent], agentBreakdowns: undefined });
      return;
    }
    const target = this.breakdowns[index]!;
    target.inputTokens += row.inputTokens;
    target.outputTokens += row.outputTokens;
    target.cacheCreationTokens += row.cacheCreationTokens;
    target.cacheReadTokens += row.cacheReadTokens;
    target.totalTokens += row.totalTokens;
    target.totalCost += row.totalCost;
    target.modelsUsed = [...new Set([...target.modelsUsed, ...row.modelsUsed])].sort(compareStrings);
    target.modelBreakdowns = mergeBreakdowns([target.modelBreakdowns, row.modelBreakdowns], true);
  }

  finish(period: string): AllRow {
    const breakdowns = this.breakdowns.map((b) => ({ ...b, period })).sort((a, b) => compareStrings(a.agent, b.agent));
    const modelBreakdowns = mergeBreakdowns(breakdowns.map((b) => b.modelBreakdowns), false).sort(byCostDesc);
    return {
      period,
      agent: "all",
      modelsUsed: [...this.models].sort(compareStrings),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      cacheReadTokens: this.cacheReadTokens,
      totalTokens: this.totalTokens,
      totalCost: this.totalCost,
      metadataAgents: [...this.agents].sort(compareStrings),
      agentBreakdowns: breakdowns,
      modelBreakdowns,
    };
  }
}

export const aggregateRows = (rows: AllRow[], kind: ReportKind): AllRow[] => {
  const groups = new Map<string, AllAccumulator>();
  for (const row of rows) {
    const period = kind === "monthly" ? row.period.slice(0, 7) : kind === "weekly" ? weekStart(row.period, "monday") : row.period;
    let group = groups.get(period);
    if (!group) groups.set(period, (group = new AllAccumulator()));
    group.add({ ...row, period });
  }
  return [...groups.keys()].sort(compareStrings).map((period) => groups.get(period)!.finish(period));
};

export const finishRows = (kind: ReportKind, rows: AllRow[], order: SortOrder, orderExplicit: boolean): AllRow[] => {
  if (kind === "session") {
    return rows
      .map((row) => ({ ...row, metadataAgents: undefined }))
      .sort((a, b) => {
        const cost = orderExplicit && order === "asc" ? a.totalCost - b.totalCost : b.totalCost - a.totalCost;
        return cost || compareStrings(a.period, b.period) || compareStrings(a.agent, b.agent);
      });
  }
  const aggregated = aggregateRows(rows, kind);
  aggregated.sort((a, b) => compareStrings(a.period, b.period) || compareStrings(a.agent, b.agent));
  if (order === "desc") aggregated.reverse();
  return aggregated;
};
