import { dateKey, rfc3339Millis, weekStart, withinRange } from "../core/dates.ts";
import type { ModelBreakdown, PricedEntry, SortOrder, UsageSummary, WeekDay } from "../core/types.ts";
import { resolveModelAlias } from "../pricing/aliases.ts";

const emptySummary = (): UsageSummary => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  extraTotalTokens: 0,
  totalCost: 0,
  modelsUsed: [],
  modelBreakdowns: [],
});

const emptyBreakdown = (modelName: string): ModelBreakdown => ({
  modelName,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  extraTotalTokens: 0,
  cost: 0,
  missingPricing: false,
});

const byCostDesc = (a: ModelBreakdown, b: ModelBreakdown) => b.cost - a.cost;

class UsageAccumulator {
  summary = emptySummary();
  private indexes = new Map<string, number>();

  add(entry: PricedEntry): void {
    const s = this.summary;
    s.inputTokens += entry.inputTokens;
    s.outputTokens += entry.outputTokens;
    s.cacheCreationTokens += entry.cacheCreationTokens;
    s.cacheReadTokens += entry.cacheReadTokens;
    s.extraTotalTokens += entry.extraTotalTokens;
    s.totalCost += entry.cost;
    if (entry.credits !== undefined) s.credits = (s.credits ?? 0) + entry.credits;
    if (entry.messageCount !== undefined) s.messageCount = (s.messageCount ?? 0) + entry.messageCount;
    if (entry.reasoningOutputTokens !== undefined) s.reasoningOutputTokens = (s.reasoningOutputTokens ?? 0) + entry.reasoningOutputTokens;
    if (!entry.model) return;
    const model = resolveModelAlias(entry.model);
    let index = this.indexes.get(model);
    if (index === undefined) {
      index = s.modelBreakdowns.length;
      this.indexes.set(model, index);
      s.modelsUsed.push(model);
      s.modelBreakdowns.push(emptyBreakdown(model));
    }
    const b = s.modelBreakdowns[index]!;
    b.inputTokens += entry.inputTokens;
    b.outputTokens += entry.outputTokens;
    b.cacheCreationTokens += entry.cacheCreationTokens;
    b.cacheReadTokens += entry.cacheReadTokens;
    b.extraTotalTokens += entry.extraTotalTokens;
    b.cost += entry.cost;
    if (entry.missingPricing) b.missingPricing = true;
  }

  finish(): UsageSummary {
    this.summary.modelBreakdowns.sort(byCostDesc);
    return this.summary;
  }
}

export const summarizeDaily = (entries: PricedEntry[], timezone: string | undefined): UsageSummary[] => {
  const groups = new Map<string, UsageAccumulator>();
  for (const entry of entries) {
    const key = dateKey(entry.timestamp, timezone);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = new UsageAccumulator()));
    group.add(entry);
  }
  return [...groups.keys()].sort().map((date) => ({ ...groups.get(date)!.finish(), date }));
};

export const summarizeSessions = (entries: PricedEntry[]): UsageSummary[] => {
  type Group = { acc: UsageAccumulator; latest: PricedEntry; earliest: number; versions: Set<string> };
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const key = `${entry.projectPath}\u0000${entry.sessionId}`;
    let group = groups.get(key);
    if (!group) {
      group = { acc: new UsageAccumulator(), latest: entry, earliest: entry.timestamp, versions: new Set() };
      groups.set(key, group);
    }
    group.acc.add(entry);
    if (entry.timestamp > group.latest.timestamp) group.latest = entry;
    if (entry.timestamp < group.earliest) group.earliest = entry.timestamp;
    if (entry.version) group.versions.add(entry.version);
  }
  return [...groups.keys()].sort().map((key) => {
    const group = groups.get(key)!;
    return {
      ...group.acc.finish(),
      sessionId: group.latest.sessionId,
      projectPath: group.latest.projectPath,
      lastActivity: group.latest.lastActivityText ?? rfc3339Millis(group.latest.timestamp),
      firstActivity: rfc3339Millis(group.earliest),
      versions: [...group.versions].sort(),
    };
  });
};

const mergeInto = (target: UsageSummary, row: UsageSummary, indexes: Map<string, number>, seen: Set<string>) => {
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.cacheCreationTokens += row.cacheCreationTokens;
  target.cacheReadTokens += row.cacheReadTokens;
  target.extraTotalTokens += row.extraTotalTokens;
  target.totalCost += row.totalCost;
  if (row.credits !== undefined) target.credits = (target.credits ?? 0) + row.credits;
  if (row.messageCount !== undefined) target.messageCount = (target.messageCount ?? 0) + row.messageCount;
  for (const model of row.modelsUsed) {
    if (!seen.has(model)) {
      seen.add(model);
      target.modelsUsed.push(model);
    }
  }
  for (const item of row.modelBreakdowns) {
    let index = indexes.get(item.modelName);
    if (index === undefined) {
      index = target.modelBreakdowns.length;
      indexes.set(item.modelName, index);
      target.modelBreakdowns.push(emptyBreakdown(item.modelName));
    }
    const b = target.modelBreakdowns[index]!;
    b.inputTokens += item.inputTokens;
    b.outputTokens += item.outputTokens;
    b.cacheCreationTokens += item.cacheCreationTokens;
    b.cacheReadTokens += item.cacheReadTokens;
    b.extraTotalTokens += item.extraTotalTokens;
    b.cost += item.cost;
    b.missingPricing ||= item.missingPricing;
  }
};

export const bucketSummaries = (rows: UsageSummary[], kind: "weekly" | "monthly", start: WeekDay): UsageSummary[] => {
  const groups = new Map<string, UsageSummary[]>();
  for (const row of rows) {
    if (!row.date) continue;
    const bucket = kind === "monthly" ? row.date.slice(0, 7) : weekStart(row.date, start);
    let list = groups.get(bucket);
    if (!list) groups.set(bucket, (list = []));
    list.push(row);
  }
  return [...groups.keys()].sort().map((bucket) => {
    const summary = emptySummary();
    const indexes = new Map<string, number>();
    const seen = new Set<string>();
    for (const row of groups.get(bucket)!) mergeInto(summary, row, indexes, seen);
    summary.modelBreakdowns.sort(byCostDesc);
    return kind === "monthly" ? { ...summary, month: bucket } : { ...summary, week: bucket };
  });
};

export const periodOf = (row: UsageSummary): string => row.date ?? row.week ?? row.month ?? row.sessionId ?? "";

export const filterByDate = (rows: UsageSummary[], since?: string, until?: string): UsageSummary[] =>
  since || until ? rows.filter((row) => withinRange(periodOf(row), since, until)) : rows;

export const filterSessions = (rows: UsageSummary[], since?: string, until?: string): UsageSummary[] =>
  since || until
    ? rows.filter((row) => {
        const date = (row.lastActivity ?? "").replaceAll("-", "");
        return (!since || date >= since) && (!until || date <= until);
      })
    : rows;

export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const sortSummaries = (rows: UsageSummary[], order: SortOrder): UsageSummary[] =>
  rows.sort((a, b) => (order === "asc" ? compareStrings(periodOf(a), periodOf(b)) : compareStrings(periodOf(b), periodOf(a))));
