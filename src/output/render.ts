import type { ModelBreakdown, ReportKind, UsageSummary } from "../core/types.ts";
import type { AllRow } from "../report/unified.ts";
import { type Style, formatCurrency, formatModels, formatNumber, shortModelName, terminalWidth } from "./style.ts";
import { type Align, Table, boxTitle } from "./table.ts";

export type RenderOptions = {
  style: Style;
  compact: boolean;
  noCost: boolean;
  breakdown: boolean;
  offline: boolean;
};

export const USAGE_COMPACT_WIDTH = 100;

export const shouldCompact = (forced: boolean, threshold = USAGE_COMPACT_WIDTH): boolean =>
  forced || (Boolean(process.stdout.isTTY) && terminalWidth() < threshold);

const FIRST_COLUMN: Record<ReportKind, string> = { daily: "Date", weekly: "Week", monthly: "Month", session: "Session" };
const TITLE_KIND: Record<ReportKind, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", session: "Session" };

export const missingPricingWarnings = (breakdowns: ModelBreakdown[], offline: boolean): string[] =>
  [...new Set(breakdowns.filter((b) => b.missingPricing).map((b) => b.modelName))].sort().map((model) =>
    offline
      ? `WARN  Missing embedded pricing for ${model}; cost excludes this model. Run without --offline or update tokenburn after pricing is added.`
      : `WARN  Missing pricing for ${model}; cost excludes this model. Add a pricingOverrides entry or run again after LiteLLM has the model.`,
  );

const breakdownLabel = (model: string) => `  └─ ${shortModelName(model)}`;

const columns = (first: string[], compact: boolean, noCost: boolean, withCacheCreate = true) => {
  const headers = [...first, "Input", "Output"];
  const aligns: Align[] = [...first.map(() => "left" as const), "right", "right"];
  if (!compact) {
    if (withCacheCreate) {
      headers.push("Cache Create");
      aligns.push("right");
    }
    headers.push("Cache Read", "Total Tokens");
    aligns.push("right", "right");
  }
  if (!noCost) {
    headers.push("Cost (USD)");
    aligns.push("right");
  }
  return { headers, aligns };
};

const numbers = (
  r: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; totalTokens: number; cost: number },
  o: RenderOptions,
) => {
  const values = [formatNumber(r.inputTokens), formatNumber(r.outputTokens)];
  if (!o.compact) values.push(formatNumber(r.cacheCreationTokens), formatNumber(r.cacheReadTokens), formatNumber(r.totalTokens));
  if (!o.noCost) values.push(formatCurrency(r.cost));
  return values;
};

const breakdownTotal = (b: ModelBreakdown) => b.inputTokens + b.outputTokens + b.cacheCreationTokens + b.cacheReadTokens + b.extraTotalTokens;

export const agentLabel = (id: string, labels: Map<string, string>): string => (id === "all" ? "All" : (labels.get(id) ?? id));

export const renderUnifiedTable = (
  rows: AllRow[],
  kind: ReportKind,
  detected: string[],
  labels: Map<string, string>,
  o: RenderOptions,
): { stdout: string; stderr: string[] } => {
  const detectedLabels = detected.length ? [...detected].sort().map((a) => agentLabel(a, labels)).join(", ") : "None";
  const title = boxTitle(`Coding (Agent) CLI Usage Report - ${TITLE_KIND[kind]}\nDetected: ${detectedLabels}`, o.style);
  if (rows.length === 0) return { stdout: title, stderr: ["No usage data found."] };
  const { headers, aligns } = columns([FIRST_COLUMN[kind], "Agent", "Models"], o.compact, o.noCost);
  const table = new Table(headers, aligns, o.style, terminalWidth());
  const grey = (cells: string[]) => cells.map((c) => o.style.color(c, "grey"));
  const pushRow = (row: AllRow, isBreakdown: boolean) => {
    const agent = isBreakdown ? `- ${agentLabel(row.agent, labels)}` : row.agentBreakdowns ? "All" : agentLabel(row.agent, labels);
    const models = row.agentBreakdowns ? "" : formatModels(row.modelsUsed);
    table.push([isBreakdown ? "" : row.period, agent, models, ...numbers({ ...row, cost: row.totalCost }, o)]);
  };
  const pushModels = (breakdowns: ModelBreakdown[]) => {
    for (const b of breakdowns)
      table.push(["", "", ...grey([breakdownLabel(b.modelName), ...numbers({ ...b, totalTokens: breakdownTotal(b) }, o)])]);
  };
  for (const row of rows) {
    pushRow(row, false);
    if (row.agentBreakdowns) {
      for (const b of row.agentBreakdowns) {
        pushRow(b, true);
        if (o.breakdown && b.modelBreakdowns.length) pushModels(b.modelBreakdowns);
      }
    } else if (o.breakdown && row.modelBreakdowns.length) pushModels(row.modelBreakdowns);
  }
  const sum = (f: (r: AllRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const totals = {
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    cacheCreationTokens: sum((r) => r.cacheCreationTokens),
    cacheReadTokens: sum((r) => r.cacheReadTokens),
    totalTokens: sum((r) => r.totalTokens),
    cost: sum((r) => r.totalCost),
  };
  table.push([o.style.color("Total", "yellow"), "", "", ...numbers(totals, o).map((v) => o.style.color(v, "yellow"))]);
  const stderr = missingPricingWarnings(rows.flatMap((r) => r.modelBreakdowns), o.offline);
  if (o.compact) stderr.push("", "Running in Compact Mode", "Expand terminal width to see cache metrics and total tokens");
  return { stdout: `${title}\n${table.render()}`, stderr };
};

const summaryTotal = (s: UsageSummary) => s.inputTokens + s.outputTokens + s.cacheCreationTokens + s.cacheReadTokens + s.extraTotalTokens;

export const renderAgentTable = (
  rows: UsageSummary[],
  kind: ReportKind,
  title: string,
  o: RenderOptions,
): { stdout: string; stderr: string[] } => {
  if (rows.length === 0) return { stdout: "", stderr: ["No usage data found."] };
  const includeLastActivity = rows.some((r) => r.lastActivity);
  const { headers, aligns } = columns([FIRST_COLUMN[kind], "Models"], o.compact, o.noCost);
  if (includeLastActivity) {
    headers.push("Last Activity");
    aligns.push("left");
  }
  const table = new Table(headers, aligns, o.style, terminalWidth());
  for (const row of rows) {
    const label = row.date ?? row.month ?? row.week ?? row.sessionId ?? "";
    const cells = [label, formatModels(row.modelsUsed), ...numbers({ ...row, totalTokens: summaryTotal(row), cost: row.totalCost }, o)];
    if (includeLastActivity) cells.push((row.lastActivity ?? "").slice(0, 10));
    table.push(cells);
    if (o.breakdown) {
      for (const b of row.modelBreakdowns) {
        const cellsB = [breakdownLabel(b.modelName), ...numbers({ ...b, totalTokens: breakdownTotal(b) }, o)];
        if (includeLastActivity) cellsB.push("");
        table.push(["", ...cellsB.map((c) => o.style.color(c, "grey"))]);
      }
    }
  }
  const sum = (f: (r: UsageSummary) => number) => rows.reduce((a, r) => a + f(r), 0);
  const totals = {
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    cacheCreationTokens: sum((r) => r.cacheCreationTokens),
    cacheReadTokens: sum((r) => r.cacheReadTokens),
    totalTokens: sum(summaryTotal),
    cost: sum((r) => r.totalCost),
  };
  const totalCells = [o.style.color("Total", "yellow"), "", ...numbers(totals, o).map((v) => o.style.color(v, "yellow"))];
  if (includeLastActivity) totalCells.push("");
  table.push(totalCells);
  const stderr = missingPricingWarnings(rows.flatMap((r) => r.modelBreakdowns), o.offline);
  if (o.compact) stderr.push("", "Running in Compact Mode", "Expand terminal width to see cache metrics and total tokens");
  return { stdout: `${boxTitle(`${title} - ${kind === "session" ? "By Session" : TITLE_KIND[kind]}`, o.style)}\n${table.render()}`, stderr };
};
