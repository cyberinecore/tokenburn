#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ADAPTERS, findAdapter } from "./adapters/registry.ts";
import { runAgentsList, runReport, type ReportArgs } from "./app.ts";
import { runBlocks, runStatusline } from "./report/blocks-command.ts";
import { loadConfig, mergedOptions } from "./core/config.ts";
import { isValidTimezone, normalizeDateBound, parseWeekDay } from "./core/dates.ts";
import type { CostMode, ReportKind, SortOrder } from "./core/types.ts";
import pkg from "../package.json" with { type: "json" };

const REPORTS: ReportKind[] = ["daily", "weekly", "monthly", "session"];

const OPTIONS = {
  json: { type: "boolean", short: "j" },
  since: { type: "string", short: "s" },
  until: { type: "string", short: "u" },
  timezone: { type: "string", short: "z" },
  all: { type: "boolean" },
  sections: { type: "string" },
  "by-agent": { type: "boolean" },
  offline: { type: "boolean", short: "O" },
  "no-offline": { type: "boolean" },
  compact: { type: "boolean" },
  "no-cost": { type: "boolean" },
  color: { type: "boolean" },
  "no-color": { type: "boolean" },
  config: { type: "string" },
  last: { type: "string" },
  mode: { type: "string", short: "m" },
  order: { type: "string", short: "o" },
  breakdown: { type: "boolean", short: "b" },
  "start-of-week": { type: "string", short: "w" },
  id: { type: "string", short: "i" },
  debug: { type: "boolean", short: "d" },
  jq: { type: "string", short: "q" },
  active: { type: "boolean", short: "a" },
  recent: { type: "boolean", short: "r" },
  "token-limit": { type: "string", short: "t" },
  "session-length": { type: "string", short: "n" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

const usage = (): string => {
  const agents = ADAPTERS.map((a) => `  ${a.id.padEnd(26)} Show ${a.product} usage commands`).join("\n");
  return `tokenburn ${pkg.version} - token usage and cost across every coding agent CLI

USAGE:
  tokenburn [daily] <OPTIONS>
  tokenburn <COMMAND> <OPTIONS>
  tokenburn <AGENT> [daily|weekly|monthly|session] <OPTIONS>

COMMANDS:
  daily                      Show all detected coding (agent) CLI usage grouped by date
  monthly                    Show all detected coding (agent) CLI usage grouped by month
  weekly                     Show all detected coding (agent) CLI usage grouped by week
  session                    Show all detected coding (agent) CLI usage grouped by session
  blocks                     Show Claude Code usage grouped by 5-hour billing blocks
  statusline                 Compact status line for Claude Code hooks (reads hook JSON on stdin)
  agents                     List supported agents, their data locations and detection state

AGENTS:
${agents}

OPTIONS:
  -j, --json                 Output in JSON format
  -s, --since <date>         Filter from date (YYYY-MM-DD or YYYYMMDD)
  -u, --until <date>         Filter until date (inclusive)
  -z, --timezone <tz>        Timezone for date grouping (IANA, "UTC" or "local")
      --last <N>             Only the most recent N periods (1 is today, this week or this month; days for session)
      --sections <list>      Emit several unified sections from one load (daily,weekly,monthly,session)
      --by-agent             Include per-agent breakdowns in unified JSON rows
  -b, --breakdown            Show per-model rows in tables
  -m, --mode <mode>          Cost mode: auto | calculate | display (default auto)
  -o, --order <order>        Sort order: asc | desc (default asc)
  -w, --start-of-week <day>  Week start for agent weekly reports (default sunday)
  -i, --id <sessionId>       Session detail for one session id (agent session report)
  -O, --offline              Use embedded pricing only (no network)
      --compact              Force compact table layout
      --no-cost              Hide cost information in table and JSON output
      --color / --no-color   Force or disable colors (NO_COLOR / FORCE_COLOR honored)
  -q, --jq <filter>          Pipe JSON output through jq
      --config <path>        Path to a config file (default: ./.tokenburn/config.json, ~/.config/tokenburn/config.json)
  -d, --debug                Print loader diagnostics to stderr
  -h, --help                 Display this help message
  -v, --version              Display this version

BLOCKS OPTIONS:
  -a, --active               Show only the active block with projections
  -r, --recent               Show blocks from the last 3 days (including active)
  -t, --token-limit <N|max>  Token limit for quota warnings
  -n, --session-length <h>   Block length in hours (default 5)
`;
};

const fail = (message: string): never => {
  console.error(`tokenburn: ${message}`);
  process.exit(1);
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2).flatMap((arg) => (/^[a-z]+:[a-z]+$/.test(arg) ? arg.split(":") : [arg]));
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    return fail((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.version) {
    console.log(pkg.version);
    return;
  }
  if (values.help) {
    console.log(usage());
    return;
  }

  let agent: string | undefined;
  let report: string = "daily";
  const [first, second, ...rest] = positionals;
  if (rest.length) return fail(`unexpected argument "${rest[0]}"`);
  if (first && findAdapter(first)) {
    agent = first;
    report = second ?? "daily";
  } else if (first) {
    if (second) return fail(`unexpected argument "${second}"`);
    report = first;
  }

  if (report === "agents") return runAgentsList(Boolean(values.json));

  const { config } = (() => {
    try {
      return loadConfig(values.config);
    } catch (error) {
      return fail((error as Error).message);
    }
  })();
  const options = { ...mergedOptions(config, agent, report), ...stripUndefined(values) } as Record<string, unknown>;

  const bool = (key: string, negated?: string) => (negated && options[negated] ? false : Boolean(options[key]));
  const str = (key: string) => (typeof options[key] === "string" ? (options[key] as string) : options[key] === undefined ? undefined : String(options[key]));

  let since: string | undefined;
  let until: string | undefined;
  try {
    since = str("since") ? normalizeDateBound(str("since")!) : undefined;
    until = str("until") ? normalizeDateBound(str("until")!) : undefined;
  } catch (error) {
    return fail((error as Error).message);
  }
  if (since && until && since > until) return fail(`--since (${since}) must not be after --until (${until})`);
  const timezone = str("timezone");
  if (timezone && !isValidTimezone(timezone)) return fail(`invalid timezone "${timezone}"`);
  const mode = (str("mode") ?? "auto") as CostMode;
  if (!["auto", "calculate", "display"].includes(mode)) return fail(`invalid --mode "${mode}"`);
  const order = (str("order") ?? "asc") as SortOrder;
  if (!["asc", "desc"].includes(order)) return fail(`invalid --order "${order}"`);
  let startOfWeek;
  try {
    startOfWeek = parseWeekDay(str("start-of-week") ?? "sunday");
  } catch (error) {
    return fail((error as Error).message);
  }
  const last = str("last") ? Number(str("last")) : undefined;
  if (last !== undefined && (!Number.isInteger(last) || last < 1)) return fail("--last must be a positive integer");
  if (last !== undefined && (since || until)) return fail("--last cannot be combined with --since or --until");

  const common = {
    json: bool("json") || str("jq") !== undefined,
    jq: str("jq"),
    since,
    until,
    timezone,
    offline: bool("offline", "no-offline"),
    compact: bool("compact"),
    noCost: bool("no-cost"),
    color: options["no-color"] ? false : options.color ? true : undefined,
    breakdown: bool("breakdown"),
    mode,
    order,
    orderExplicit: str("order") !== undefined,
    startOfWeek,
    debug: bool("debug"),
    config,
  };

  if (report === "blocks" || report === "statusline") {
    if (agent && agent !== "claude") return fail(`${report} is only available for Claude Code`);
    const blockArgs = {
      ...common,
      active: bool("active"),
      recent: bool("recent"),
      tokenLimit: str("token-limit"),
      sessionLength: str("session-length") ? Number(str("session-length")) : 5,
    };
    if (report === "blocks") return runBlocks(blockArgs);
    return runStatusline({ ...blockArgs, offline: options["no-offline"] ? false : true });
  }

  if (!REPORTS.includes(report as ReportKind)) return fail(`unknown command "${report}". Run tokenburn --help`);
  const kind = report as ReportKind;
  if (agent) {
    const adapter = findAdapter(agent)!;
    if (!adapter.reports.includes(kind)) return fail(`${adapter.product} does not support the ${kind} report`);
  }

  const sections = str("sections")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (sections) {
    if (agent) return fail("--sections is only valid on the unified report");
    const bad = sections.find((s) => !REPORTS.includes(s as ReportKind));
    if (bad) return fail(`invalid section "${bad}"`);
    if (last !== undefined) return fail("--last cannot be combined with --sections");
  }

  const args: ReportArgs = {
    ...common,
    kind,
    agent,
    byAgent: bool("by-agent"),
    sections: sections ? ([...new Set(sections)] as ReportKind[]) : undefined,
    last,
    id: str("id"),
  };
  await runReport(args);
};

const stripUndefined = (values: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));

main().catch((error) => {
  const debug = process.argv.includes("--debug") || process.argv.includes("-d");
  console.error(`tokenburn: ${debug ? ((error as Error).stack ?? error) : ((error as Error).message ?? error)}`);
  process.exit(1);
});
