import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { envPaths, home, isDir, walk } from "../core/fs.ts";
import { parseFilesParallel } from "../core/pool.ts";
import { dateKey, weekStart, withinRange } from "../core/dates.ts";
import type { Adapter, LoadContext, PricedEntry, ReportKind, UsageEntry } from "../core/types.ts";
import { resolveModelAlias } from "../pricing/aliases.ts";
import autoReviewFallbacks from "./data/codex-auto-review-fallbacks.json" with { type: "json" };

type RawUsage = {
  input: number;
  cached: number;
  cacheCreation: number;
  output: number;
  reasoning: number;
  total: number;
};

export type CodexEvent = RawUsage & {
  timestamp: string;
  model?: string;
  isFallback: boolean;
  serviceTier?: "standard" | "fast";
};

type CodexFileResult = {
  file: string;
  sessionId: string;
  events: CodexEvent[];
  meta: { id?: string; parentId?: string; timestamp?: number };
  burstStart?: number;
};

const num = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
};

export const parseRawUsage = (value: unknown): RawUsage | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const input = num(v.input_tokens) ?? num(v.prompt_tokens) ?? num(v.input) ?? 0;
  const output = num(v.output_tokens) ?? num(v.completion_tokens) ?? num(v.output) ?? 0;
  const reasoning = num(v.reasoning_output_tokens) ?? num(v.reasoning_tokens) ?? 0;
  const cached = Math.min(num(v.cached_input_tokens) ?? num(v.cache_read_input_tokens) ?? num(v.cached_tokens) ?? 0, input);
  const cacheCreation = Math.min(num(v.cache_write_input_tokens) ?? num(v.cache_creation_input_tokens) ?? 0, Math.max(input - cached, 0));
  const recordedTotal = num(v.total_tokens);
  return { input, cached, cacheCreation, output, reasoning, total: recordedTotal && recordedTotal > 0 ? recordedTotal : input + output };
};

const normalizeUsage = (u: RawUsage): RawUsage => {
  const cached = Math.min(u.cached, u.input);
  return { ...u, cached, cacheCreation: Math.min(u.cacheCreation, Math.max(u.input - cached, 0)) };
};

const subtractUsage = (current: RawUsage, previous: RawUsage | undefined): RawUsage =>
  normalizeUsage({
    input: Math.max(current.input - (previous?.input ?? 0), 0),
    cached: Math.max(current.cached - (previous?.cached ?? 0), 0),
    cacheCreation: Math.max(current.cacheCreation - (previous?.cacheCreation ?? 0), 0),
    output: Math.max(current.output - (previous?.output ?? 0), 0),
    reasoning: Math.max(current.reasoning - (previous?.reasoning ?? 0), 0),
    total: Math.max(current.total - (previous?.total ?? 0), 0),
  });

const sameUsage = (a: RawUsage | undefined, b: RawUsage | undefined): boolean =>
  !!a && !!b && a.input === b.input && a.cached === b.cached && a.cacheCreation === b.cacheCreation && a.output === b.output && a.reasoning === b.reasoning && a.total === b.total;

const isoMillis = (ms: number): string => new Date(ms).toISOString();

const normalizeTimestamp = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? undefined : isoMillis(ms);
  }
  const raw = num(value);
  if (raw === undefined) return undefined;
  return isoMillis(raw > 10_000_000_000 ? raw : raw * 1000);
};

const sessionTimestamp = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const text = value.trim();
    return text || undefined;
  }
  return normalizeTimestamp(value);
};

const validDate = (timestamp: string): string | undefined => {
  const date = timestamp.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const [y, m, d] = date.split("-").map(Number);
  const probe = new Date(Date.UTC(y!, m! - 1, d!));
  return probe.getUTCMonth() === m! - 1 && probe.getUTCDate() === d ? date : undefined;
};

const rawOrNormalized = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    return validDate(text) ? text : normalizeTimestamp(text);
  }
  return normalizeTimestamp(value);
};

const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

const modelFromFields = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  return nonEmpty(v.model) ?? nonEmpty(v.model_name) ?? nonEmpty((v.metadata as Record<string, unknown> | undefined)?.model);
};

const AUTO_REVIEW = "codex-auto-review";

const autoReviewModel = (timestamp: string): string => {
  const date = validDate(timestamp);
  if (!date) return "gpt-5";
  return (autoReviewFallbacks as { releasedOn: string; model: string }[]).find((f) => date >= f.releasedOn)?.model ?? "gpt-5";
};

type ModelState = { current?: string; isFallback: boolean };

const resolveModel = (parsed: string | undefined, timestamp: string, state: ModelState): { model: string; isFallback: boolean } => {
  if (parsed) {
    state.current = parsed;
    state.isFallback = false;
  }
  let isFallback = false;
  let model = parsed ?? state.current;
  if (!model) {
    isFallback = true;
    state.isFallback = true;
    state.current = "gpt-5";
    model = "gpt-5";
  }
  if (parsed && state.current && state.isFallback) isFallback = true;
  if (model === AUTO_REVIEW) {
    isFallback = true;
    model = autoReviewModel(timestamp);
  }
  return { model, isFallback };
};

const serviceTier = (value: string): "standard" | "fast" | undefined =>
  value === "default" || value === "standard" ? "standard" : value === "fast" || value === "priority" ? "fast" : undefined;

const typeValueRe = /"type"\s*:\s*"([a-z_]+)"/g;

const lineKind = (line: string): "session" | "headless" | undefined => {
  const hasEventMsg = line.includes('"event_msg"');
  const hasTokenCount = hasEventMsg && line.includes('"token_count"');
  const hasSettings = hasEventMsg && line.includes('"thread_settings_applied"');
  if (line.includes('"turn_context"') || hasTokenCount || hasSettings) {
    typeValueRe.lastIndex = 0;
    let turn = false,
      event = false,
      token = false,
      settings = false;
    for (const match of line.matchAll(typeValueRe)) {
      const value = match[1];
      turn ||= value === "turn_context";
      event ||= value === "event_msg";
      token ||= value === "token_count";
      settings ||= value === "thread_settings_applied";
      if (turn || (event && (token || settings))) return "session";
    }
  }
  if (line.includes('"usage":') || line.includes('"input_tokens":') || line.includes('"prompt_tokens":')) return "headless";
  return undefined;
};

const firstLineMeta = (content: string): CodexFileResult["meta"] => {
  const end = content.indexOf("\n");
  const first = end < 0 ? content : content.slice(0, end);
  try {
    const value = JSON.parse(first) as Record<string, any>;
    const payload = value.type === "session_meta" ? value.payload : undefined;
    const ts = normalizeTimestamp(value.timestamp);
    const parent = nonEmpty(payload?.forked_from_id) ?? nonEmpty(payload?.source?.subagent?.thread_spawn?.parent_thread_id);
    return { id: typeof payload?.id === "string" ? payload.id : undefined, parentId: parent, timestamp: ts ? Date.parse(ts) : undefined };
  } catch {
    return {};
  }
};

export const parseCodexFile = (file: string, sessionsDir: string): CodexFileResult => {
  const sessionId = relative(sessionsDir, file).replace(/\.jsonl$/, "").split(sep).join("/") || "unknown";
  let content = "";
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return { file, sessionId, events: [], meta: {} };
  }
  let fallbackTimestamp: string;
  try {
    fallbackTimestamp = isoMillis(Math.floor(statSync(file).mtimeMs));
  } catch {
    fallbackTimestamp = isoMillis(0);
  }
  const events: CodexEvent[] = [];
  const modelState: ModelState = { isFallback: false };
  let previousTotals: RawUsage | undefined;
  let tier: "standard" | "fast" | undefined;
  const burst: number[] = [];
  let start = 0;
  while (start < content.length) {
    let end = content.indexOf("\n", start);
    if (end < 0) end = content.length;
    const line = content.slice(start, end);
    start = end + 1;
    const kind = lineKind(line);
    if (!kind) continue;
    let value: Record<string, any>;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (kind === "session") {
      const type = value.type;
      if (type === "turn_context") {
        const model = modelFromFields(value.payload);
        if (model) {
          modelState.current = model;
          modelState.isFallback = false;
        }
        continue;
      }
      if (type !== "event_msg") continue;
      const timestamp = sessionTimestamp(value.timestamp);
      const payload = value.payload;
      if (!timestamp || !payload || typeof payload !== "object") continue;
      if (payload.type === "thread_settings_applied") {
        const recorded = payload.thread_settings?.service_tier;
        if (typeof recorded === "string") tier = serviceTier(recorded);
        continue;
      }
      if (payload.type !== "token_count") continue;
      const info = payload.info && typeof payload.info === "object" ? payload.info : undefined;
      const totalUsage = parseRawUsage(info?.total_token_usage);
      const lastUsage = parseRawUsage(info?.last_token_usage);
      if (burst.length < 2 && (lastUsage || totalUsage)) {
        const ms = Date.parse(timestamp);
        if (!Number.isNaN(ms)) burst.push(ms);
      }
      const advanced = !totalUsage || !sameUsage(previousTotals, totalUsage);
      const raw = (advanced ? lastUsage : undefined) ?? (totalUsage ? subtractUsage(totalUsage, previousTotals) : undefined);
      if (totalUsage) previousTotals = totalUsage;
      if (!raw) continue;
      const usage = normalizeUsage(raw);
      if (usage.input === 0 && usage.cached === 0 && usage.cacheCreation === 0 && usage.output === 0 && usage.reasoning === 0) continue;
      const parsedModel = modelFromFields(payload) ?? modelFromFields(info);
      const { model, isFallback } = resolveModel(parsedModel, timestamp, modelState);
      events.push({ ...usage, timestamp, model, isFallback, serviceTier: tier });
      continue;
    }
    const usageRaw = parseRawUsage(value.usage) ?? parseRawUsage(value.data?.usage) ?? parseRawUsage(value.result?.usage) ?? parseRawUsage(value.response?.usage);
    if (!usageRaw) continue;
    const usage = normalizeUsage(usageRaw);
    if (usage.input === 0 && usage.cached === 0 && usage.cacheCreation === 0 && usage.output === 0 && usage.reasoning === 0 && usage.total === 0) continue;
    const parsedModel = modelFromFields(value) ?? modelFromFields(value.data) ?? modelFromFields(value.result) ?? modelFromFields(value.response);
    const pick = (f: (v: unknown) => string | undefined) =>
      [value, value.data, value.result, value.response].map((v) => (v && typeof v === "object" ? f(v.timestamp) ?? f(v.created_at) ?? f(v.createdAt) : undefined)).find(Boolean);
    const eventTs = pick(normalizeTimestamp) ?? fallbackTimestamp;
    const modelTs = pick(rawOrNormalized) ?? fallbackTimestamp;
    const { model, isFallback } = resolveModel(parsedModel, modelTs, modelState);
    events.push({ ...usage, timestamp: eventTs, model, isFallback });
  }
  const burstStart = burst.length === 2 && burst[1]! - burst[0]! >= 0 && burst[1]! - burst[0]! <= 1000 ? burst[0] : undefined;
  return { file, sessionId, events, meta: firstLineMeta(content), burstStart };
};

const REWRITTEN_BURST_PAUSE_MS = 1000;

const applyReplay = (events: CodexEvent[], prefix: RawUsage[] | undefined, burstStart: number | undefined): CodexEvent[] => {
  if (prefix === undefined) return events;
  const out: CodexEvent[] = [];
  let state: { kind: "match"; index: number } | { kind: "burst"; previous: number } | { kind: "done" } = { kind: "match", index: 0 };
  for (const event of events) {
    for (;;) {
      if (state.kind === "match") {
        if (sameUsage(prefix[state.index], event)) {
          state = { kind: "match", index: state.index + 1 };
          break;
        }
        state = state.index === 0 && burstStart !== undefined ? { kind: "burst", previous: burstStart } : { kind: "done" };
        continue;
      }
      if (state.kind === "burst") {
        const ts = Date.parse(event.timestamp);
        if (!Number.isNaN(ts) && ts - state.previous >= 0 && ts - state.previous <= REWRITTEN_BURST_PAUSE_MS) {
          state = { kind: "burst", previous: ts };
          break;
        }
        state = { kind: "done" };
        continue;
      }
      out.push(event);
      break;
    }
  }
  return out;
};

export const codexHomes = (): string[] => {
  if (process.env.CODEX_HOME !== undefined) return [...new Set(envPaths("CODEX_HOME"))];
  return [join(home(), ".codex")];
};

type Source = { dir: string; scope: string };

const codexSources = (): Source[] => {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const root of codexHomes()) {
    let found = false;
    for (const name of ["sessions", "archived_sessions"]) {
      const dir = join(root, name);
      if (!isDir(dir)) continue;
      found = true;
      if (!seen.has(dir)) {
        seen.add(dir);
        sources.push({ dir, scope: root });
      }
    }
    if (!found && isDir(root) && !seen.has(root)) {
      seen.add(root);
      sources.push({ dir: root, scope: root });
    }
  }
  return sources;
};

const codexFiles = (): { file: string; dir: string }[] => {
  const seen = new Set<string>();
  const out: { file: string; dir: string }[] = [];
  for (const source of codexSources()) {
    const files = [...walk(source.dir, (n) => n.endsWith(".jsonl"))].sort();
    for (const file of files) {
      const key = `${source.scope}\u0000${relative(source.dir, file)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, dir: source.dir });
    }
  }
  return out;
};

const readFirstLine = (file: string): string => {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(65536);
    for (let position = 0; position < 16 * 1024 * 1024; ) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      const newline = buffer.subarray(0, read).indexOf(10);
      if (newline >= 0) {
        chunks.push(Buffer.from(buffer.subarray(0, newline)));
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, read)));
      position += read;
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const sinceThreshold = (since: string): number =>
  Date.parse(`${since.slice(0, 4)}-${since.slice(4, 6)}-${since.slice(6, 8)}T00:00:00Z`) - 14 * 3_600_000 - 86_400_000;

const selectFiles = (files: string[], since: string | undefined): string[] => {
  if (!since) return files;
  const threshold = sinceThreshold(since);
  if (threshold > Date.now()) return files;
  const recent = new Set(
    files.filter((file) => {
      try {
        return statSync(file).mtimeMs >= threshold;
      } catch {
        return true;
      }
    }),
  );
  const metas = new Map(files.map((file) => [file, firstLineMeta(readFirstLine(file))]));
  const byId = new Map<string, string[]>();
  for (const [file, meta] of metas) {
    if (!meta.id) continue;
    let list = byId.get(meta.id);
    if (!list) byId.set(meta.id, (list = []));
    list.push(file);
  }
  for (const file of [...recent]) {
    const parent = metas.get(file)?.parentId;
    if (!parent) continue;
    const parentFile = byId.get(parent)?.find((candidate) => candidate !== file);
    if (parentFile) recent.add(parentFile);
  }
  return files.filter((file) => recent.has(file));
};

export const codexFastByConfig = (): boolean =>
  codexHomes().some((root) => {
    try {
      return readFileSync(join(root, "config.toml"), "utf8")
        .split("\n")
        .some((line) => {
          const setting = line.split("#")[0]!.trim();
          const at = setting.indexOf("=");
          if (at < 0 || setting.slice(0, at).trim() !== "service_tier") return false;
          const value = setting.slice(at + 1).trim().replace(/^["']+|["']+$/g, "");
          return value === "fast" || value === "priority";
        });
    } catch {
      return false;
    }
  });

type ModelUsage = {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  isFallback: boolean;
  missingPricing?: boolean;
  cost: number;
};

const codexReportJson = (kind: ReportKind, entries: PricedEntry[], options: { timezone?: string; since?: string; until?: string }) => {
  const groups = new Map<string, { models: Map<string, ModelUsage>; lastActivity?: string }>();
  for (const entry of entries) {
    const date = dateKey(entry.timestamp, options.timezone);
    if (!withinRange(date, options.since, options.until)) continue;
    const period = kind === "daily" ? date : kind === "weekly" ? weekStart(date, "monday") : kind === "monthly" ? date.slice(0, 7) : entry.sessionId;
    let group = groups.get(period);
    if (!group) groups.set(period, (group = { models: new Map() }));
    const text = entry.lastActivityText ?? new Date(entry.timestamp).toISOString();
    if (!group.lastActivity || text > group.lastActivity) group.lastActivity = text;
    const model = entry.model!;
    let usage = group.models.get(model);
    if (!usage) group.models.set(model, (usage = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, isFallback: false, cost: 0 }));
    usage.inputTokens += entry.inputTokens;
    usage.cacheCreationTokens += entry.cacheCreationTokens;
    usage.cacheReadTokens += entry.cacheReadTokens;
    usage.outputTokens += entry.outputTokens;
    usage.reasoningOutputTokens += entry.reasoningOutputTokens ?? 0;
    usage.totalTokens += entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens + entry.extraTotalTokens;
    usage.isFallback ||= Boolean(entry.isFallbackModel);
    usage.cost += entry.cost;
    if (entry.missingPricing) usage.missingPricing = true;
  }
  const periodKey = kind === "daily" ? "date" : kind === "weekly" ? "week" : kind === "monthly" ? "month" : "sessionId";
  const totals = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, costUSD: 0 };
  const unpriced = new Set<string>();
  const rows = [...groups.keys()].sort().map((period) => {
    const group = groups.get(period)!;
    const row: Record<string, unknown> = { [periodKey]: period, inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, costUSD: 0 };
    const models: Record<string, unknown> = {};
    for (const [model, usage] of [...group.models.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      for (const key of ["inputTokens", "cacheCreationTokens", "cacheReadTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const) {
        (row[key] as number) += usage[key];
        totals[key] += usage[key];
      }
      (row.costUSD as number) += usage.cost;
      totals.costUSD += usage.cost;
      if (usage.missingPricing) unpriced.add(model);
      const { cost: _cost, ...rest } = usage;
      models[model] = rest;
    }
    row.models = models;
    if (kind === "session") {
      row.lastActivity = group.lastActivity ?? null;
      const at = period.lastIndexOf("/");
      row.sessionFile = at < 0 ? period : period.slice(at + 1);
      row.directory = at < 0 ? "" : period.slice(0, at);
    }
    return row;
  });
  const totalsOut: Record<string, unknown> = { ...totals };
  if (unpriced.size) totalsOut.unpricedModels = [...unpriced].sort();
  return { [kind === "session" ? "sessions" : kind]: rows, totals: totalsOut };
};

export const codex: Adapter = {
  id: "codex",
  label: "Codex",
  product: "Codex",
  envVars: ["CODEX_HOME"],
  reports: ["daily", "monthly", "session"],
  hasData: () => codexFiles().length > 0,
  reportJson: codexReportJson,
  parseFiles: (files, options) => {
    const dirs = (options?.dirByFile as Record<string, string>) ?? {};
    return files.map((file) => [parseCodexFile(file, dirs[file] ?? "")]);
  },
  async load(ctx: LoadContext): Promise<UsageEntry[]> {
    const discovered = codexFiles();
    const selected = new Set(selectFiles(discovered.map((f) => f.file), ctx.since));
    const all = discovered.filter((f) => selected.has(f.file));
    const dirByFile = new Map(all.map((f) => [f.file, f.dir]));
    const files = all.map((f) => f.file);
    const perFile = await parseFilesParallel<CodexFileResult>(
      { parser: "codex", files, options: { dirByFile: Object.fromEntries(dirByFile) } },
      (chunk) => chunk.map((file) => [parseCodexFile(file, dirByFile.get(file)!)]),
    );
    const results = perFile.map((r) => r[0]!).filter(Boolean);
    const bySessionId = new Map<string, CodexFileResult[]>();
    for (const result of results) {
      if (!result.meta.id) continue;
      let list = bySessionId.get(result.meta.id);
      if (!list) bySessionId.set(result.meta.id, (list = []));
      list.push(result);
    }
    const fast = codexFastByConfig();
    const sessionScoped = ctx.kind === "session";
    const seen = new Set<string>();
    const entries: UsageEntry[] = [];
    for (const result of results) {
      let prefix: RawUsage[] | undefined;
      if (result.meta.parentId) {
        const parent = bySessionId.get(result.meta.parentId)?.find((candidate) => candidate.file !== result.file);
        if (parent) {
          const forkedAt = result.meta.timestamp;
          const cut = forkedAt === undefined ? -1 : parent.events.findIndex((e) => Date.parse(e.timestamp) > forkedAt);
          prefix = cut < 0 ? parent.events : parent.events.slice(0, cut);
        } else prefix = [];
      }
      for (const event of applyReplay(result.events, prefix, result.burstStart)) {
        const timestamp = Date.parse(event.timestamp);
        if (Number.isNaN(timestamp) || !event.model) continue;
        const model = resolveModelAlias(event.model);
        const key = [sessionScoped ? result.sessionId : "", timestamp, model, event.input, event.cached, event.cacheCreation, event.output, event.reasoning, event.total].join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        const nonCached = Math.max(event.input - event.cached - event.cacheCreation, 0);
        const tierFast = fast ? event.serviceTier !== "standard" : event.serviceTier === "fast";
        entries.push({
          agent: "codex",
          timestamp,
          sessionId: result.sessionId,
          projectPath: "",
          model,
          inputTokens: nonCached,
          outputTokens: event.output,
          cacheCreationTokens: event.cacheCreation,
          cacheReadTokens: event.cached,
          extraTotalTokens: event.total - (nonCached + event.output + event.cacheCreation + event.cached),
          reasoningOutputTokens: event.reasoning,
          requestInputTokens: event.input,
          costStyle: "codex",
          speed: tierFast ? "fast" : undefined,
          isFallbackModel: event.isFallback,
          lastActivityText: event.timestamp,
        });
      }
    }
    return entries;
  },
};
