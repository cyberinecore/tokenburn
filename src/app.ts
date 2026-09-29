import { spawnSync } from "node:child_process";
import { ADAPTERS, adapterLabels, findAdapter } from "./adapters/registry.ts";
import type { ConfigFile } from "./core/config.ts";
import { pricingOverrides } from "./core/config.ts";
import { dateKey, lastPeriodsSince, resolveTimezone, withinRange } from "./core/dates.ts";
import type { Adapter, CostMode, LoadContext, PricedEntry, ReportKind, SortOrder, UsageSummary, WeekDay } from "./core/types.ts";
import { type Json, allRowJson, allTotalsJson, genericSessionJson, renderJson, sessionSummaryJson, summaryJson, totalsJson } from "./output/json.ts";
import { renderAgentTable, renderUnifiedTable, shouldCompact } from "./output/render.ts";
import { makeStyle } from "./output/style.ts";
import { priceEntries } from "./pricing/cost.ts";
import { PricingEngine, type PricingOverride } from "./pricing/pricing.ts";
import { bucketSummaries, filterByDate, filterSessions, sortSummaries, summarizeDaily, summarizeSessions } from "./report/summary.ts";
import { type AllRow, finishRows, summaryRows } from "./report/unified.ts";

export type CommonArgs = {
  json: boolean;
  jq?: string;
  since?: string;
  until?: string;
  timezone?: string;
  offline: boolean;
  compact: boolean;
  noCost: boolean;
  color?: boolean;
  breakdown: boolean;
  mode: CostMode;
  order: SortOrder;
  orderExplicit: boolean;
  startOfWeek: WeekDay;
  debug: boolean;
  config: ConfigFile;
};

export type ReportArgs = CommonArgs & {
  kind: ReportKind;
  agent?: string;
  byAgent: boolean;
  sections?: ReportKind[];
  last?: number;
  id?: string;
};

export type LoadedAgent = { adapter: Adapter; detected: boolean; entries: PricedEntry[] };

export const loadContext = (args: CommonArgs, kind: ReportKind, last?: number, since = args.since): LoadContext => ({
  kind,
  last,
  since,
  until: args.until,
  timezone: resolveTimezone(args.timezone),
  offline: args.offline,
  mode: args.mode,
  debug: args.debug,
  warn: (message) => console.error(message),
});

export const loadPricing = (args: CommonArgs) =>
  PricingEngine.load({
    offline: args.offline,
    overrides: pricingOverrides(args.config, {}) as Record<string, PricingOverride>,
    warn: (message) => {
      if (args.debug) console.error(message);
    },
  });

export const loadAgents = async (adapters: Adapter[], args: CommonArgs, kind: ReportKind, last?: number, since?: string): Promise<LoadedAgent[]> => {
  const ctx = loadContext(args, kind, last, since ?? args.since);
  const [engine, loaded] = await Promise.all([
    loadPricing(args),
    Promise.all(
      adapters.map(async (adapter) => {
        const started = performance.now();
        const detected = adapter.hasData();
        if (!detected) return { adapter, detected, raw: [] };
        try {
          const raw = await adapter.load(ctx);
          if (args.debug) console.error(`[${adapter.id}] ${raw.length} entries in ${Math.round(performance.now() - started)}ms`);
          return { adapter, detected, raw };
        } catch (error) {
          console.error(`tokenburn: failed to load ${adapter.product} usage: ${(error as Error).message}`);
          return { adapter, detected, raw: [] };
        }
      }),
    ),
  ]);
  return loaded.map(({ adapter, detected, raw }) => ({
    adapter,
    detected,
    entries: priceEntries(raw, engine, adapter.id === "claude" ? args.mode : "auto"),
  }));
};

const resolveLast = (args: ReportArgs, kind: ReportKind): string | undefined => {
  if (args.last === undefined) return args.since;
  const today = dateKey(Date.now(), resolveTimezone(args.timezone));
  const unit = kind === "daily" || kind === "session" ? "day" : kind === "weekly" ? "week" : "month";
  const start = args.agent ? args.startOfWeek : "monday";
  return lastPeriodsSince(unit, args.last, today, start);
};

const entriesInRange = (entries: PricedEntry[], since: string | undefined, until: string | undefined, tz: string | undefined) =>
  since || until ? entries.filter((e) => withinRange(dateKey(e.timestamp, tz), since, until)) : entries;

export const agentSummaries = (entries: PricedEntry[], kind: ReportKind, args: CommonArgs, since?: string): UsageSummary[] => {
  const tz = resolveTimezone(args.timezone);
  if (kind === "session") return summarizeSessions(entriesInRange(entries, since, args.until, tz));
  const daily = sortSummaries(filterByDate(summarizeDaily(entries, tz), since, args.until), args.order);
  if (kind === "daily") return daily;
  return sortSummaries(bucketSummaries(daily, kind, kind === "weekly" ? args.startOfWeek : "sunday"), args.order);
};

const unifiedRows = (loaded: LoadedAgent[], kind: ReportKind, args: ReportArgs): AllRow[] => {
  const since = resolveLast(args, kind);
  const tz = resolveTimezone(args.timezone);
  const rows: AllRow[] = [];
  for (const { adapter, entries } of loaded) {
    if (kind === "session") {
      rows.push(...summaryRows(adapter.id, filterSessions(summarizeSessions(entries), since, args.until)));
    } else {
      rows.push(...summaryRows(adapter.id, filterByDate(summarizeDaily(entries, tz), since, args.until)));
    }
  }
  return finishRows(kind, rows, args.order, args.orderExplicit);
};

const emit = (text: string, jq: string | undefined) => {
  if (!jq) {
    process.stdout.write(`${text}\n`);
    return;
  }
  const result = spawnSync("jq", [jq], { input: text, stdio: ["pipe", "inherit", "inherit"] });
  if (result.error) throw new Error(`failed to run jq: ${result.error.message}`);
  if (result.status !== 0) throw new Error("jq failed");
};

const rowsKey = (kind: ReportKind) => kind;

export const runReport = async (args: ReportArgs): Promise<void> => {
  const style = makeStyle(args.color);
  const renderOptions = { style, compact: shouldCompact(args.compact), noCost: args.noCost, breakdown: args.breakdown, offline: args.offline };

  if (args.agent) {
    const adapter = findAdapter(args.agent)!;
    const since = resolveLast(args, args.kind);
    const [loaded] = await loadAgents([adapter], args, args.kind, args.last, args.kind === "session" ? undefined : since);
    const style = adapter.sessionStyle ?? "generic";
    let rows =
      args.kind === "session" && style === "generic-with-activity"
        ? filterSessions(summarizeSessions(loaded!.entries), since, args.until)
        : agentSummaries(loaded!.entries, args.kind, args, since);
    if (args.kind === "session") {
      if (args.id) return runSessionDetail(loaded!.entries, args, since);
      if (style === "claude") {
        rows = rows.filter((r) => r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens > 0);
        rows.sort((a, b) => (args.orderExplicit && args.order === "asc" ? a.totalCost - b.totalCost : b.totalCost - a.totalCost));
      } else sortSummaries(rows, args.order);
    }
    if (args.json && adapter.reportJson && !args.id) {
      const value = adapter.reportJson(args.kind, loaded!.entries, { timezone: resolveTimezone(args.timezone), since, until: args.until }) as Json;
      emit(renderJson(value, { noCost: args.noCost }), args.jq);
      return;
    }
    if (args.json) {
      const key = args.kind === "session" ? "sessions" : args.kind;
      const value: Json = {
        [key]: rows.map((row) =>
          args.kind !== "session" ? summaryJson(row) : style === "claude" ? sessionSummaryJson(row) : genericSessionJson(row, style !== "generic"),
        ),
        totals: rows.length === 0 && adapter.emptyTotalsNull ? null : totalsJson(rows),
      };
      emit(renderJson(value, { noCost: args.noCost }), args.jq);
      return;
    }
    const out = renderAgentTable(rows, args.kind, `${adapter.product} Token Usage Report`, renderOptions);
    if (out.stdout) process.stdout.write(`${out.stdout}\n`);
    for (const line of out.stderr) console.error(line);
    return;
  }

  const loadKind = args.sections ? (args.sections.every((s) => s === "session") ? "session" : "daily") : args.kind;
  const loadSince = args.sections || args.kind === "session" ? undefined : resolveLast(args, args.kind);
  const loaded = await loadAgents(ADAPTERS, args, loadKind, args.last, loadSince);
  const detected = loaded.filter((l) => l.detected).map((l) => l.adapter.id);
  if (args.sections) {
    const sections = args.sections.map((kind) => [kind, unifiedRows(loaded, kind, args)] as const);
    if (args.json) {
      const value: Record<string, Json> = {};
      for (const [kind, rows] of sections) value[rowsKey(kind)] = rows.map((r) => allRowJson(r, args.byAgent));
      const command = sections.find(([kind]) => kind === args.kind) ?? sections[0]!;
      value.totals = allTotalsJson(command[1]);
      const sorted = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, JSON.parse(renderJson(v, { noCost: args.noCost }))]));
      emit(JSON.stringify(sorted, null, 2), args.jq);
      return;
    }
    for (const [kind, rows] of sections) {
      const out = renderUnifiedTable(rows, kind, detected, adapterLabels(), renderOptions);
      process.stdout.write(`${out.stdout}\n`);
      for (const line of out.stderr) console.error(line);
    }
    return;
  }

  const rows = unifiedRows(loaded, args.kind, args);
  if (args.json) {
    const value: Json = { [rowsKey(args.kind)]: rows.map((r) => allRowJson(r, args.byAgent)), totals: allTotalsJson(rows) };
    emit(renderJson(value, { noCost: args.noCost }), args.jq);
    return;
  }
  const out = renderUnifiedTable(rows, args.kind, detected, adapterLabels(), renderOptions);
  process.stdout.write(`${out.stdout}\n`);
  for (const line of out.stderr) console.error(line);
};

const runSessionDetail = (entries: PricedEntry[], args: ReportArgs, since: string | undefined) => {
  const tz = resolveTimezone(args.timezone);
  const matches = entriesInRange(entries, since, args.until, tz)
    .filter((e) => e.sessionId === args.id)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (matches.length === 0) {
    console.error(`No session found with ID: ${args.id}`);
    process.exitCode = 1;
    return;
  }
  const value: Json = {
    sessionId: args.id!,
    totalCost: matches.reduce((a, e) => a + e.cost, 0),
    totalTokens: matches.reduce((a, e) => a + e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens + e.extraTotalTokens, 0),
    entries: matches.map((e) => ({
      timestamp: new Date(e.timestamp).toISOString(),
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheCreationTokens: e.cacheCreationTokens,
      cacheReadTokens: e.cacheReadTokens,
      model: e.model ?? "unknown",
      costUSD: e.cost,
    })),
  };
  if (args.json) {
    emit(renderJson(value, { noCost: args.noCost }), args.jq);
    return;
  }
  const rows = agentSummaries(matches, "daily", args);
  const out = renderAgentTable(rows, "daily", `Session ${args.id}`, {
    style: makeStyle(args.color),
    compact: shouldCompact(args.compact),
    noCost: args.noCost,
    breakdown: true,
    offline: args.offline,
  });
  if (out.stdout) process.stdout.write(`${out.stdout}\n`);
};

export const runAgentsList = (json: boolean): void => {
  const rows = ADAPTERS.map((a) => ({ id: a.id, name: a.product, detected: a.hasData(), env: a.envVars, reports: a.reports }));
  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  for (const row of rows) {
    process.stdout.write(`${row.detected ? "*" : " "} ${row.id.padEnd(14)} ${row.name.padEnd(22)} ${row.env.join(", ")}\n`);
  }
  process.stdout.write("\n* = usage data found on this machine\n");
};
