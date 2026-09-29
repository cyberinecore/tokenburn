import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { home, isDir, listDir } from "../core/fs.ts";
import { nextCompactDate, startOfDayMs } from "../core/dates.ts";
import type { Adapter, LoadContext, UsageEntry } from "../core/types.ts";
import { applyTotalTokenFallback } from "../core/tokens.ts";
import { filesWithExtension, isFile, isObj, nonEmpty, type Obj, parseTsTimestamp, readText, u64 } from "./common.ts";

type Kind = "otel" | "session-state";

const copilotRoot = (): string => {
  const value = process.env.COPILOT_HOME?.trim();
  return value ? value : join(home(), ".copilot");
};

const sources = (): { kind: Kind; path: string }[] => {
  const out: { kind: Kind; path: string }[] = [];
  const seen = new Set<string>();
  const add = (kind: Kind, path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ kind, path });
  };
  const root = copilotRoot();
  const otel = join(root, "otel");
  if (isDir(otel)) for (const path of filesWithExtension(otel, "jsonl")) add("otel", path);
  const state = join(root, "session-state");
  for (const name of listDir(state)) {
    if (!isDir(join(state, name))) continue;
    const path = join(state, name, "events.jsonl");
    if (isFile(path)) add("session-state", path);
  }
  const exporter = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH?.trim();
  if (exporter && isFile(exporter)) add("otel", exporter);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

type CopilotEntry = {
  timestamp: number;
  sessionId: string;
  model: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  reasoning: number;
  extra: number;
  requests: number;
  dedupKey: string;
};

const str = (value: unknown): string | undefined => nonEmpty(value);

const numberValue = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : undefined;
  if (typeof value === "string") return /^\+?\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;
  return undefined;
};

const normalizeModel = (model: string): string => {
  const m = model.trim();
  if (m.endsWith("-1m-internal")) return m.slice(0, -"-1m-internal".length);
  if (m.endsWith("-1m")) return m.slice(0, -"-1m".length);
  return m;
};

const readLines = (file: string, needle: string): Obj[] => {
  const out: Obj[] = [];
  for (const line of (readText(file) ?? "").split("\n")) {
    if (!line.includes(needle)) continue;
    try {
      const value = JSON.parse(line);
      if (isObj(value)) out.push(value);
    } catch {}
  }
  return out;
};

const uncachedInput = (usage: Obj) => Math.max(u64(usage.inputTokens) - (u64(usage.cacheReadTokens) + u64(usage.cacheWriteTokens)), 0);

const parseSessionState = (file: string): CopilotEntry[] => {
  const sessionId = basename(dirname(file)).trim();
  if (!sessionId) return [];
  const out: CopilotEntry[] = [];
  for (const event of readLines(file, "session.shutdown")) {
    if (str(event.type) !== "session.shutdown") continue;
    const text = str(event.timestamp);
    const timestamp = text === undefined ? undefined : parseTsTimestamp(text);
    if (timestamp === undefined) continue;
    const metrics = isObj(event.data) && isObj(event.data.modelMetrics) ? event.data.modelMetrics : undefined;
    if (!metrics || Object.values(metrics).some((metric) => !isObj(metric))) continue;
    const eventId = str(event.id);
    for (const rawModel of Object.keys(metrics).sort()) {
      const metric: Obj = metrics[rawModel];
      const model = normalizeModel(rawModel);
      const requests = isObj(metric.requests) ? u64(metric.requests.count) : 0;
      if (!isObj(metric.usage)) continue;
      const usage = metric.usage;
      const fields = [u64(usage.inputTokens), u64(usage.outputTokens), u64(usage.cacheReadTokens), u64(usage.cacheWriteTokens), u64(usage.reasoningTokens)];
      if (!model || (fields.every((f) => f === 0) && requests === 0)) continue;
      const iso = new Date(timestamp).toISOString();
      out.push({
        timestamp,
        sessionId,
        model,
        input: uncachedInput(usage),
        output: fields[1]!,
        cacheCreation: fields[3]!,
        cacheRead: fields[2]!,
        reasoning: fields[4]!,
        extra: 0,
        requests,
        dedupKey: eventId ? `shutdown:${sessionId}:${eventId}:${model}` : `shutdown:${sessionId}:${iso}:${model}:${fields.join(":")}:${requests}`,
      });
    }
  }
  return out;
};

type Source = "chat" | "inference" | "agent-turn" | "agent-summary";

const MODEL_ATTRS = ["gen_ai.response.model", "gen_ai.request.model"];
const SESSION_ATTRS: [string, number][] = [
  ["gen_ai.conversation.id", 3],
  ["copilot_chat.session_id", 3],
  ["copilot_chat.chat_session_id", 3],
  ["session.id", 3],
  ["github.copilot.interaction_id", 2],
  ["gen_ai.response.id", 1],
];

const modelAttr = (attrs: Obj): string | undefined => {
  for (const key of MODEL_ATTRS) {
    const value = str(attrs[key]);
    if (value !== undefined) return normalizeModel(value);
  }
  return undefined;
};

const sessionAttr = (attrs: Obj): [string, number] | undefined => {
  let best: [string, number] | undefined;
  for (const [key, priority] of SESSION_ATTRS) {
    const value = str(attrs[key]);
    if (value !== undefined && (!best || priority >= best[1])) best = [value, priority];
  }
  return best;
};

const traceIdOf = (r: Obj): string | undefined => str(r.traceId) ?? (isObj(r.spanContext) ? str(r.spanContext.traceId) : undefined);
const spanIdOf = (r: Obj): string | undefined => str(r.spanId) ?? (isObj(r.spanContext) ? str(r.spanContext.spanId) : undefined);
const bodyOf = (r: Obj): string | undefined => str(r.body) ?? str(r._body);

const isSpan = (r: Obj): boolean => {
  if (typeof r.type === "string") return r.type === "span";
  const present = (v: unknown) => v !== undefined && v !== null;
  return (
    str(r.name) !== undefined &&
    (str(r.spanId) !== undefined || str(r.traceId) !== undefined || present(r.startTime) || present(r.endTime) || present(r.duration) || present(r.kind))
  );
};

const sourceOf = (r: Obj, attrs: Obj): Source | undefined => {
  const op = str(attrs["gen_ai.operation.name"]);
  const name = str(r.name);
  const span = isSpan(r);
  const event = str(attrs["event.name"]);
  const body = bodyOf(r);
  if (span && (op === "chat" || name?.startsWith("chat "))) return "chat";
  if (!span && (event === "gen_ai.client.inference.operation.details" || body?.startsWith("GenAI inference:"))) return "inference";
  if (!span && (event === "copilot_chat.agent.turn" || body?.startsWith("copilot_chat.agent.turn"))) return "agent-turn";
  if (span && (op === "invoke_agent" || name?.startsWith("invoke_agent "))) return "agent-summary";
  return undefined;
};

const fromParts = (value: unknown): number | undefined => {
  if (!Array.isArray(value)) return undefined;
  const seconds = numberValue(value[0]);
  const nanos = numberValue(value[1]);
  if (seconds === undefined || nanos === undefined) return undefined;
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
};

const fromScalar = (value: unknown): number | undefined => {
  const raw = numberValue(value);
  if (raw === undefined) return undefined;
  if (raw >= 1e17) return Math.floor(raw / 1_000_000);
  if (raw >= 1e14) return Math.floor(raw / 1_000);
  if (raw >= 1e11) return raw;
  return raw * 1000;
};

const fromUnixNanos = (value: unknown): number | undefined => {
  const raw = numberValue(value);
  return raw !== undefined && raw > 0 ? Math.floor(raw / 1_000_000) : undefined;
};

const recordTimestamp = (r: Obj): number | undefined =>
  fromParts(r.endTime) ??
  fromParts(r.startTime) ??
  fromParts(r.hrTime) ??
  fromParts(r._hrTime) ??
  fromParts(r.time) ??
  fromScalar(r.timestamp) ??
  fromScalar(r.observedTimestamp) ??
  fromUnixNanos(r.timeUnixNano);

const attrNumber = (attrs: Obj, key: string) => numberValue(attrs[key]) ?? 0;
const attrFirst = (attrs: Obj, keys: string[]) => keys.map((key) => attrNumber(attrs, key)).find((v) => v > 0) ?? 0;

type Candidate = CopilotEntry & { source: Source; traceId?: string; responseId?: string };

const parseOtel = (file: string): CopilotEntry[] => {
  const records = readLines(file, '"attributes"').filter((r) => r.attributes === undefined || r.attributes === null || isObj(r.attributes));
  const contexts = new Map<string, { model?: string; sessionId?: string; priority: number }>();
  for (const r of records) {
    const traceId = traceIdOf(r);
    if (traceId === undefined || !isObj(r.attributes)) continue;
    let context = contexts.get(traceId);
    if (!context) {
      context = { priority: 0 };
      contexts.set(traceId, context);
    }
    context.model ??= modelAttr(r.attributes);
    const best = sessionAttr(r.attributes);
    if (best && best[1] > context.priority) {
      context.sessionId = best[0];
      context.priority = best[1];
    }
  }
  let fallback = Date.now();
  try {
    fallback = Math.floor(statSync(file).mtimeMs);
  } catch {}
  const candidates: Candidate[] = [];
  records.forEach((r, index) => {
    if (!isObj(r.attributes)) return;
    const attrs = r.attributes;
    const source = sourceOf(r, attrs);
    if (!source) return;
    const input = attrNumber(attrs, "gen_ai.usage.input_tokens");
    const cacheRead = attrNumber(attrs, "gen_ai.usage.cache_read.input_tokens");
    const tokens = {
      input: input - Math.min(input, cacheRead),
      output: attrNumber(attrs, "gen_ai.usage.output_tokens"),
      cacheCreation: attrFirst(attrs, ["gen_ai.usage.cache_write.input_tokens", "gen_ai.usage.cache_creation.input_tokens"]),
      cacheRead,
    };
    const reasoning = attrFirst(attrs, ["gen_ai.usage.reasoning.output_tokens", "gen_ai.usage.reasoning_tokens"]);
    const { usage, extra } = applyTotalTokenFallback(tokens, 0, attrFirst(attrs, ["gen_ai.usage.total_tokens", "gen_ai.usage.total.token_count"]));
    if (usage.input + usage.output + usage.cacheCreation + usage.cacheRead + extra === 0) return;
    const traceId = traceIdOf(r);
    const context = traceId === undefined ? undefined : contexts.get(traceId);
    const model = modelAttr(attrs) ?? context?.model ?? "unknown";
    const sessionId = sessionAttr(attrs)?.[0] ?? context?.sessionId ?? traceId ?? "unknown-session";
    const timestamp = recordTimestamp(r) ?? fallback;
    const spanId = spanIdOf(r);
    let dedupKey: string;
    if (source === "chat" || source === "agent-summary") dedupKey = traceId && spanId ? `${traceId}:${spanId}` : `span:${sessionId}:${timestamp}:${index}`;
    else if (source === "inference") dedupKey = traceId && spanId ? `log:${traceId}:${spanId}` : `log:${sessionId}:${timestamp}:${index}`;
    else {
      const turn = numberValue(attrs["turn.index"]) ?? numberValue(attrs["copilot_chat.turn.index"]);
      const turnIndex = turn === undefined ? `idx-${index}` : String(turn);
      dedupKey = traceId ? `agent-turn:${traceId}:${turnIndex}` : `agent-turn:${sessionId}:${turnIndex}:${index}`;
    }
    candidates.push({
      source,
      traceId,
      responseId: str(attrs["gen_ai.response.id"]),
      timestamp,
      sessionId,
      model,
      input: usage.input,
      output: usage.output,
      cacheCreation: usage.cacheCreation,
      cacheRead: usage.cacheRead,
      reasoning,
      extra,
      requests: 1,
      dedupKey,
    });
  });
  const ids = (source: Source, pick: (c: Candidate) => string | undefined) =>
    new Set(candidates.filter((c) => c.source === source).map(pick).filter((v): v is string => v !== undefined));
  const traces = { chat: ids("chat", (c) => c.traceId), inference: ids("inference", (c) => c.traceId), turn: ids("agent-turn", (c) => c.traceId) };
  const responses = { chat: ids("chat", (c) => c.responseId), inference: ids("inference", (c) => c.responseId), turn: ids("agent-turn", (c) => c.responseId) };
  const hit = (set: Set<string>, value: string | undefined) => value !== undefined && set.has(value);
  return candidates
    .filter((c) => {
      const t = (set: Set<string>) => hit(set, c.traceId);
      const r = (set: Set<string>) => hit(set, c.responseId);
      if (c.source === "chat") return true;
      if (c.source === "inference") return !t(traces.chat) && !r(responses.chat);
      if (c.source === "agent-turn") return !t(traces.chat) && !t(traces.inference) && !r(responses.chat) && !r(responses.inference);
      return !t(traces.chat) && !t(traces.inference) && !t(traces.turn) && !r(responses.chat) && !r(responses.inference) && !r(responses.turn);
    })
    .map(({ source: _s, traceId: _t, responseId: _r, ...entry }) => entry);
};

const dedupeSessionEntries = (entries: CopilotEntry[]): CopilotEntry[] => {
  const indexes = new Map<string, number>();
  entries.forEach((entry, index) => {
    const previous = indexes.get(entry.dedupKey);
    if (previous === undefined || entries[previous]!.timestamp <= entry.timestamp) indexes.set(entry.dedupKey, index);
  });
  return [...indexes.values()].sort((a, b) => a - b).map((index) => entries[index]!);
};

const subtract = (current: CopilotEntry, base: CopilotEntry): CopilotEntry => ({
  ...current,
  input: Math.max(current.input - base.input, 0),
  output: Math.max(current.output - base.output, 0),
  cacheCreation: Math.max(current.cacheCreation - base.cacheCreation, 0),
  cacheRead: Math.max(current.cacheRead - base.cacheRead, 0),
  reasoning: Math.max(current.reasoning - base.reasoning, 0),
  extra: Math.max(current.extra - base.extra, 0),
  requests: Math.max(current.requests - base.requests, 0),
});

const hasUsage = (e: CopilotEntry) => e.input > 0 || e.output > 0 || e.cacheCreation > 0 || e.cacheRead > 0 || e.reasoning > 0 || e.extra > 0 || e.requests > 0;

const byTimeThenKey = (a: CopilotEntry, b: CopilotEntry) => a.timestamp - b.timestamp || (a.dedupKey < b.dedupKey ? -1 : a.dedupKey > b.dedupKey ? 1 : 0);

const reconcile = (raw: CopilotEntry[], since: number | undefined, until: number | undefined) => {
  const entries = dedupeSessionEntries(raw);
  const grouped = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const key = JSON.stringify([entry.sessionId, entry.model]);
    const list = grouped.get(key);
    if (list) list.push(index);
    else grouped.set(key, [index]);
  });
  const intervals: CopilotEntry[] = [];
  const shutdowns: CopilotEntry[] = [];
  for (const key of [...grouped.keys()].sort()) {
    const sorted = grouped.get(key)!.sort((a, b) => entries[a]!.timestamp - entries[b]!.timestamp || a - b);
    let latest = -1;
    sorted.forEach((index, position) => {
      if (until === undefined || entries[index]!.timestamp < until) latest = position;
    });
    if (latest < 0) continue;
    shutdowns.push(entries[sorted[latest]!]!);
    let previous: CopilotEntry | undefined;
    for (let position = 0; position <= latest; position++) {
      const current = entries[sorted[position]!]!;
      if (since !== undefined && current.timestamp < since) {
        previous = current;
        continue;
      }
      const reconciled = previous ? subtract(current, previous) : current;
      previous = current;
      if (hasUsage(reconciled)) intervals.push(reconciled);
    }
  }
  return { intervals: intervals.sort(byTimeThenKey), shutdowns: shutdowns.sort(byTimeThenKey) };
};

const toUsageEntry = (e: CopilotEntry): UsageEntry => ({
  agent: "copilot",
  timestamp: e.timestamp,
  sessionId: e.sessionId,
  projectPath: "GitHub Copilot CLI",
  model: e.model,
  inputTokens: e.input,
  outputTokens: e.output,
  cacheCreationTokens: e.cacheCreation,
  cacheReadTokens: e.cacheRead,
  extraTotalTokens: e.extra,
  extraBilledAsOutput: true,
  reasoningOutputTokens: e.reasoning,
  messageCount: e.requests > 0 ? e.requests : undefined,
});

export const copilot: Adapter = {
  id: "copilot",
  label: "Copilot",
  product: "GitHub Copilot CLI",
  envVars: ["COPILOT_HOME", "COPILOT_OTEL_FILE_EXPORTER_PATH"],
  reports: ["daily", "monthly", "session"],
  sessionStyle: "entries-with-activity",
  hasData: () => sources().length > 0,
  async load(ctx: LoadContext): Promise<UsageEntry[]> {
    const otel: CopilotEntry[] = [];
    const state: CopilotEntry[] = [];
    for (const { kind, path } of sources()) {
      if (kind === "otel") otel.push(...parseOtel(path));
      else state.push(...parseSessionState(path));
    }
    const since = ctx.since ? startOfDayMs(ctx.since, ctx.timezone) : undefined;
    const until = ctx.until ? startOfDayMs(nextCompactDate(ctx.until), ctx.timezone) : undefined;
    const { intervals, shutdowns } = reconcile(state, since, until);
    const latestShutdown = new Map(shutdowns.map((e) => [JSON.stringify([e.sessionId, e.model]), e.timestamp]));
    const kept = otel.filter((e) => {
      const shutdown = latestShutdown.get(JSON.stringify([e.sessionId, e.model]));
      return shutdown === undefined || e.timestamp > shutdown;
    });
    return [...intervals, ...kept].map(toUsageEntry).sort((a, b) => a.timestamp - b.timestamp);
  },
};
