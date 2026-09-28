import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claude, parseClaudeFiles } from "../adapters/claude.ts";
import { type CommonArgs, loadAgents, loadPricing } from "../app.ts";
import { dateKey, resolveTimezone, withinRange } from "../core/dates.ts";
import { home } from "../core/fs.ts";
import type { PricedEntry } from "../core/types.ts";
import { renderJson } from "../output/json.ts";
import { formatCurrency, formatModels, formatNumber, makeStyle, type Style, terminalWidth } from "../output/style.ts";
import { type Align, Table, boxTitle } from "../output/table.ts";
import { priceEntries } from "../pricing/cost.ts";
import { WARNING_THRESHOLD, blockJson, blockTotal, burnRate, identifySessionBlocks, parseTokenLimit, projectBlock, type SessionBlock } from "./blocks.ts";

export type BlockArgs = CommonArgs & { active: boolean; recent: boolean; tokenLimit?: string; sessionLength: number };

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const BLOCKS_COMPACT_WIDTH = 120;

const localParts = (ms: number, timezone: string | undefined) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
};

const pad = (n: number) => String(n).padStart(2, "0");
const hour12 = (h: number) => (h % 12 === 0 ? 12 : h % 12);
const ampm = (h: number) => (h < 12 ? "AM" : "PM");

const blockStart = (ms: number, compact: boolean, tz?: string) => {
  const p = localParts(ms, tz);
  return compact
    ? `${pad(p.month)}/${pad(p.day)}, ${pad(hour12(p.hour))}:${pad(p.minute)} ${ampm(p.hour)}`
    : `${p.month}/${p.day}/${p.year}, ${hour12(p.hour)}:${pad(p.minute)}:${pad(p.second)} ${ampm(p.hour)}`;
};

const blockEnd = (ms: number, compact: boolean, tz?: string) => {
  const p = localParts(ms, tz);
  return compact ? `${pad(hour12(p.hour))}:${pad(p.minute)} ${ampm(p.hour)}` : blockStart(ms, false, tz);
};

const blockTime = (block: SessionBlock, compact: boolean, tz?: string): string => {
  const start = blockStart(block.startTime, compact, tz);
  if (block.isGap) {
    const hours = Math.trunc((block.endTime - block.startTime) / HOUR);
    const end = blockEnd(block.endTime, compact, tz);
    return compact ? `${start}-${end}\n(${hours}h gap)` : `${start} - ${end} (${hours}h gap)`;
  }
  if (block.isActive) {
    const now = Date.now();
    const elapsed = Math.trunc((now - block.startTime) / MINUTE);
    const remaining = Math.trunc((block.endTime - now) / MINUTE);
    const [eh, em, rh, rm] = [Math.trunc(elapsed / 60), elapsed % 60, Math.trunc(remaining / 60), remaining % 60];
    return compact ? `${start}\n(${eh}h${em}m/${rh}h${rm}m)` : `${start} (${eh}h ${em}m elapsed, ${rh}h ${rm}m remaining)`;
  }
  const minutes = block.actualEndTime !== undefined ? Math.trunc((block.actualEndTime - block.startTime) / MINUTE) : 0;
  const [h, m] = [Math.trunc(minutes / 60), minutes % 60];
  if (compact) return h > 0 ? `${start}\n(${h}h${m}m)` : `${start}\n(${m}m)`;
  return h > 0 ? `${start} (${h}h ${m}m)` : `${start} (${m}m)`;
};

const loadClaudeEntries = async (args: CommonArgs): Promise<PricedEntry[]> => {
  const [loaded] = await loadAgents([claude], args, "daily");
  return loaded?.entries ?? [];
};

const renderBlocksTable = (blocks: SessionBlock[], args: BlockArgs, maxTokens: number, style: Style): string => {
  const compact = args.compact || (Boolean(process.stdout.isTTY) && terminalWidth() < BLOCKS_COMPACT_WIDTH);
  const tz = resolveTimezone(args.timezone);
  const limit = parseTokenLimit(args.tokenLimit, maxTokens);
  const showPercent = limit !== undefined && limit > 0;
  const headers = ["Block Start", "Duration/Status", "Models", "Tokens"];
  const aligns: Align[] = ["left", "left", "left", "right"];
  if (showPercent) {
    headers.push("%");
    aligns.push("right");
  }
  if (!args.noCost) {
    headers.push("Cost");
    aligns.push("right");
  }
  const table = new Table(headers, aligns, style, terminalWidth());
  for (const block of blocks) {
    if (block.isGap) {
      const row = [style.color(blockTime(block, compact, tz), "grey"), style.color("(inactive)", "grey"), style.color("-", "grey"), style.color("-", "grey")];
      if (showPercent) row.push(style.color("-", "grey"));
      if (!args.noCost) row.push(style.color("-", "grey"));
      table.push(row);
      continue;
    }
    const total = blockTotal(block);
    const row = [blockTime(block, compact, tz), block.isActive ? style.color("ACTIVE", "green") : "", block.models.length ? formatModels(block.models) : "-", formatNumber(total)];
    if (showPercent) {
      const pct = (total / limit!) * 100;
      row.push(pct > 100 ? style.color(`${pct.toFixed(1)}%`, "red") : `${pct.toFixed(1)}%`);
    }
    if (!args.noCost) row.push(formatCurrency(block.costUSD));
    table.push(row);
    if (!block.isActive) continue;
    if (showPercent) {
      const remaining = Math.max(limit! - total, 0);
      const remainingPct = (remaining / limit!) * 100;
      const r = [
        style.color(`(assuming ${formatNumber(limit!)} token limit)`, "grey"),
        style.color("REMAINING", "blue"),
        "",
        remaining > 0 ? formatNumber(remaining) : style.color("0", "red"),
        remainingPct > 0 ? `${remainingPct.toFixed(1)}%` : style.color("0.0%", "red"),
      ];
      if (!args.noCost) r.push("");
      table.push(r);
    }
    const projection = projectBlock(block);
    if (projection) {
      const p = [
        style.color("(assuming current burn rate)", "grey"),
        style.color("PROJECTED", "yellow"),
        "",
        showPercent && projection.totalTokens > limit! ? style.color(formatNumber(projection.totalTokens), "red") : formatNumber(projection.totalTokens),
      ];
      if (showPercent) p.push(`${((projection.totalTokens / limit!) * 100).toFixed(1)}%`);
      if (!args.noCost) p.push(formatCurrency(projection.totalCost));
      table.push(p);
    }
  }
  return `${boxTitle("Claude Code Token Usage Report - Session Blocks", style)}\n${table.render()}`;
};

const activeDetail = (block: SessionBlock, args: BlockArgs, maxTokens: number, style: Style): string => {
  const now = Date.now();
  const elapsed = Math.trunc((now - block.startTime) / MINUTE);
  const remaining = Math.trunc((block.endTime - now) / MINUTE);
  const lines = [
    boxTitle("Current Session Block Status", style),
    `Block Started:   ${new Date(block.startTime).toISOString().replace("T", " ").slice(0, 19)} UTC`,
    `Time Elapsed:    ${Math.trunc(elapsed / 60)}h ${elapsed % 60}m`,
    `Time Remaining:  ${style.color(`${Math.trunc(remaining / 60)}h ${remaining % 60}m`, "green")}`,
    "",
    style.color("Current Usage:", "blue"),
    `  Input Tokens:     ${formatNumber(block.inputTokens)}`,
    `  Output Tokens:    ${formatNumber(block.outputTokens)}`,
  ];
  if (!args.noCost) lines.push(`  Total Cost:       ${formatCurrency(block.costUSD)}`);
  const rate = burnRate(block);
  if (rate) {
    lines.push("", style.color("Burn Rate:", "blue"), `  Tokens/minute:    ${formatNumber(Math.round(rate.tokensPerMinute))}`);
    if (!args.noCost) lines.push(`  Cost/hour:        ${formatCurrency(rate.costPerHour)}`);
  }
  const projection = projectBlock(block);
  if (projection) {
    lines.push("", style.color("Projected Usage (if current rate continues):", "blue"), `  Total Tokens:     ${formatNumber(projection.totalTokens)}`);
    if (!args.noCost) lines.push(`  Total Cost:       ${formatCurrency(projection.totalCost)}`);
    const limit = parseTokenLimit(args.tokenLimit, maxTokens);
    if (limit !== undefined) {
      const current = blockTotal(block);
      const pct = (projection.totalTokens / limit) * 100;
      const status =
        projection.totalTokens > limit
          ? style.color("EXCEEDS LIMIT", "red")
          : projection.totalTokens > limit * WARNING_THRESHOLD
            ? style.color("WARNING", "yellow")
            : style.color("OK", "green");
      lines.push(
        "",
        style.color("Token Limit Status:", "blue"),
        `  Limit:            ${formatNumber(limit)} tokens`,
        `  Current Usage:    ${formatNumber(current)} (${((current / limit) * 100).toFixed(1)}%)`,
        `  Remaining:        ${formatNumber(Math.max(limit - current, 0))} tokens`,
        `  Projected Usage:  ${pct.toFixed(1)}% ${status}`,
      );
    }
  }
  return lines.join("\n");
};

export const runBlocks = async (args: BlockArgs): Promise<void> => {
  if (!(args.sessionLength > 0)) throw new Error("Session length must be a positive number");
  const entries = await loadClaudeEntries(args);
  const tz = resolveTimezone(args.timezone);
  let blocks = identifySessionBlocks(entries, args.sessionLength);
  if (args.since || args.until) blocks = blocks.filter((b) => withinRange(dateKey(b.startTime, tz), args.since, args.until));
  blocks.sort((a, b) => a.startTime - b.startTime);
  if (args.order === "desc") blocks.reverse();
  if (args.recent) {
    const cutoff = Date.now() - 3 * DAY;
    blocks = blocks.filter((b) => b.startTime >= cutoff || b.isActive);
  }
  if (args.active) blocks = blocks.filter((b) => b.isActive);
  const maxTokens = Math.max(0, ...blocks.filter((b) => !b.isGap && !b.isActive).map(blockTotal));
  if (args.json) {
    process.stdout.write(`${renderJson({ blocks: blocks.map((b) => blockJson(b, args.tokenLimit, maxTokens)) as never }, { noCost: args.noCost })}\n`);
    return;
  }
  const style = makeStyle(args.color);
  if (args.active && blocks.length === 0) {
    process.stdout.write("No active session block found.\n");
    return;
  }
  if (args.active && blocks.length === 1) {
    process.stdout.write(`${activeDetail(blocks[0]!, args, maxTokens, style)}\n`);
    return;
  }
  if (blocks.length === 0) {
    console.error("No Claude usage data found.");
    return;
  }
  process.stdout.write(`${renderBlocksTable(blocks, args, maxTokens, style)}\n`);
};

type Hook = {
  session_id: string;
  transcript_path: string;
  model: { id?: string; display_name: string };
  cost?: { total_cost_usd: number };
  context_window?: { total_input_tokens: number; context_window_size: number };
  effort?: { level: string };
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const cachePath = (sessionId: string) =>
  join(process.env.XDG_CACHE_HOME || join(home(), ".cache"), "tokenburn", "statusline", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

const transcriptContext = (path: string, contextLimit: number | undefined): { tokens: number; size: number } | undefined => {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line || !line.includes('"assistant"')) continue;
    try {
      const value = JSON.parse(line);
      const usage = value?.type === "assistant" ? value.message?.usage : undefined;
      if (!usage || typeof usage.input_tokens !== "number") continue;
      return {
        tokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        size: contextLimit ?? 200_000,
      };
    } catch {}
  }
  return undefined;
};

export const runStatusline = async (args: BlockArgs & { refreshSeconds?: number }): Promise<void> => {
  const input = (await readStdin()).trim();
  if (!input) throw new Error("No input provided");
  let hook: Hook;
  try {
    hook = JSON.parse(input) as Hook;
  } catch (error) {
    throw new Error(`Invalid input format: ${(error as Error).message}`);
  }
  if (!hook || typeof hook !== "object") throw new Error("Invalid input format: expected a JSON object");
  for (const field of ["session_id", "transcript_path"] as const) {
    if (typeof hook[field] !== "string") throw new Error(`Invalid input format: missing field \`${field}\``);
  }
  if (typeof hook.model?.display_name !== "string") throw new Error("Invalid input format: missing field `model.display_name`");
  const style = makeStyle(args.color);
  const path = cachePath(hook.session_id);
  let transcriptMtime = 0;
  try {
    transcriptMtime = statSync(hook.transcript_path).mtimeMs;
  } catch {}
  try {
    const cached = JSON.parse(readFileSync(path, "utf8")) as { input: string; mtime: number; at: number; output: string };
    if (cached.input === input && cached.mtime === transcriptMtime && Date.now() - cached.at < (args.refreshSeconds ?? 1) * 1000) {
      process.stdout.write(`${cached.output}\n`);
      return;
    }
  } catch {}

  const tz = resolveTimezone(args.timezone);
  const now = Date.now();
  const today = dateKey(now, tz).replaceAll("-", "");
  const lookbackSince = dateKey(now - 5 * HOUR - 30 * DAY, tz).replaceAll("-", "");
  const entries = await loadClaudeEntries({ ...args, since: lookbackSince, until: undefined, json: true });
  const todayCost = entries.filter((e) => dateKey(e.timestamp, tz).replaceAll("-", "") === today).reduce((a, e) => a + e.cost, 0);

  const engine = await loadPricing(args);
  let sessionCost = hook.cost?.total_cost_usd;
  if (sessionCost === undefined) {
    const own = priceEntries(parseClaudeFiles([hook.transcript_path]).flat(), engine, args.mode);
    sessionCost = own.reduce((a, e) => a + e.cost, 0);
  }

  const active = identifySessionBlocks(entries, 5).find((b) => b.isActive && !b.isGap);
  let blockInfo = "No active block";
  let burnInfo = "";
  if (active) {
    const remaining = Math.trunc((active.endTime - now) / MINUTE);
    const left = remaining >= 60 ? `${Math.trunc(remaining / 60)}h ${remaining % 60}m left` : `${remaining}m left`;
    blockInfo = `${formatCurrency(active.costUSD)} block (${left})`;
    const rate = burnRate(active);
    if (rate) {
      const level = rate.tokensPerMinuteForIndicator < 2000 ? "Normal" : rate.tokensPerMinuteForIndicator < 5000 ? "Moderate" : "High";
      burnInfo = ` | Burn: ${formatCurrency(rate.costPerHour)}/hr (${level})`;
    }
  }

  const context = hook.context_window
    ? { tokens: hook.context_window.total_input_tokens, size: hook.context_window.context_window_size }
    : transcriptContext(hook.transcript_path, hook.model.id?.includes("[1m]") ? 1_000_000 : hook.model.id ? engine.contextLimit(hook.model.id) : undefined);
  let contextInfo = "N/A";
  if (context) {
    const pct = context.size ? Math.round((context.tokens / context.size) * 100) : 0;
    const color = pct < 50 ? "green" : pct < 80 ? "yellow" : "red";
    contextInfo = `${formatNumber(context.tokens)} (${style.color(`${pct}%`, color)})`;
  }
  const model = hook.effort?.level ? `${hook.model.display_name} (${hook.effort.level})` : hook.model.display_name;
  const output = `${model} | Cost: ${formatCurrency(sessionCost ?? 0)} session / ${formatCurrency(todayCost)} today / ${blockInfo}${burnInfo} | Context: ${contextInfo}`;
  process.stdout.write(`${output}\n`);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ input, mtime: transcriptMtime, at: Date.now(), output }), { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {}
};
