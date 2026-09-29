import { realpathSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { home, isDir } from "../core/fs.ts";
import { openReadonly } from "../core/sqlite.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { filesWithExtension } from "./common.ts";

const DEFAULT_MODEL = "gemini-internal-model";
const PROVIDER_PREFIXES = ["google", "gemini", "vertex_ai", "openrouter/google"];
const GOOGLE_PROVIDERS = new Set([3, 24, 30]);
const DEFAULT_ROOTS = [".gemini/antigravity", ".gemini/antigravity-cli", ".gemini/antigravity-ide", ".gemini/antigravity-backup", ".config/antigravity"];

const roots = (): string[] => {
  const value = process.env.ANTIGRAVITY_DATA_DIR;
  if (value !== undefined)
    return value
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  return DEFAULT_ROOTS.map((root) => join(home(), root));
};

export const antigravityDbPaths = (): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots()) {
    const nested = join(root, "conversations");
    const dir = isDir(nested) ? nested : root;
    for (const path of filesWithExtension(dir, "db")) {
      let canonical = path;
      try {
        canonical = realpathSync(path);
      } catch {}
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      out.push(path);
    }
  }
  return out.sort();
};

type Field = { number: number; varint?: bigint; bytes?: Uint8Array };

class ProtoError extends Error {}

const readVarint = (blob: Uint8Array, at: { pos: number }): bigint => {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    const shift = BigInt(i * 7);
    if (at.pos >= blob.length) throw new ProtoError("truncated protobuf varint");
    const byte = blob[at.pos++]!;
    const payload = BigInt(byte & 0x7f);
    if (i === 9 && payload > 1n) throw new ProtoError("protobuf varint overflow");
    value |= payload << shift;
    if ((byte & 0x80) === 0) return value;
    if (i === 9) throw new ProtoError("protobuf varint overflow");
  }
  throw new ProtoError("protobuf varint overflow");
};

const take = (blob: Uint8Array, at: { pos: number }, length: number): Uint8Array => {
  if (blob.length - at.pos < length) throw new ProtoError("truncated protobuf fixed-width value");
  const out = blob.subarray(at.pos, at.pos + length);
  at.pos += length;
  return out;
};

const decode = (blob: Uint8Array): Field[] => {
  const fields: Field[] = [];
  const at = { pos: 0 };
  while (at.pos < blob.length) {
    const tag = readVarint(blob, at);
    const number = tag >> 3n;
    if (number > 0xffffffffn) throw new ProtoError("protobuf field number overflow");
    if (number === 0n) throw new ProtoError("protobuf field number is zero");
    const wire = Number(tag & 7n);
    if (wire === 0) fields.push({ number: Number(number), varint: readVarint(blob, at) });
    else if (wire === 1) {
      take(blob, at, 8);
      fields.push({ number: Number(number) });
    } else if (wire === 2) {
      const length = readVarint(blob, at);
      fields.push({ number: Number(number), bytes: take(blob, at, Number(length)) });
    } else if (wire === 5) {
      take(blob, at, 4);
      fields.push({ number: Number(number) });
    } else throw new ProtoError("unsupported protobuf wire type");
  }
  return fields;
};

const varint = (fields: Field[], n: number): bigint | undefined => {
  for (let i = fields.length - 1; i >= 0; i--) if (fields[i]!.number === n && fields[i]!.varint !== undefined) return fields[i]!.varint;
  return undefined;
};

const varintNum = (fields: Field[], n: number): number | undefined => {
  const v = varint(fields, n);
  return v === undefined ? undefined : Number(v);
};

const nonZero = (value: number | undefined) => (value === undefined || value === 0 ? undefined : value);

const bytes = (fields: Field[], n: number): Uint8Array | undefined => fields.find((f) => f.number === n && f.bytes !== undefined)?.bytes;

const bytesAll = (fields: Field[], n: number): Uint8Array[] => fields.filter((f) => f.number === n && f.bytes !== undefined).map((f) => f.bytes!);

const utf8 = new TextDecoder("utf-8", { fatal: true });

const text = (fields: Field[], n: number): string | undefined => {
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i]!;
    if (f.number !== n || f.bytes === undefined) continue;
    try {
      const value = utf8.decode(f.bytes);
      return value.trim() ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

type ModelUsage = {
  modelId?: number;
  input: number;
  totalOutput: number;
  cacheCreation: number;
  cacheRead: number;
  reasoning: number;
  visibleOutput: number;
  provider?: number;
  messageId?: string;
  responseId?: string;
  providerMessageId?: string;
};

const parseModelUsage = (blob: Uint8Array): ModelUsage => {
  const f = decode(blob);
  return {
    modelId: nonZero(varintNum(f, 1)),
    input: varintNum(f, 2) ?? 0,
    totalOutput: varintNum(f, 3) ?? 0,
    cacheCreation: varintNum(f, 4) ?? 0,
    cacheRead: varintNum(f, 5) ?? 0,
    reasoning: varintNum(f, 9) ?? 0,
    visibleOutput: varintNum(f, 10) ?? 0,
    provider: nonZero(varintNum(f, 6)),
    messageId: text(f, 7),
    responseId: text(f, 11),
    providerMessageId: text(f, 12),
  };
};

const parseRetry = (blob: Uint8Array): ModelUsage | undefined => {
  const usage = bytes(decode(blob), 2);
  return usage ? parseModelUsage(usage) : undefined;
};

const parseTimestampMessage = (blob: Uint8Array): number | undefined => {
  const f = decode(blob);
  const seconds = varint(f, 1);
  if (seconds === undefined || seconds <= 0n || seconds > 9223372036854775807n) return undefined;
  const nanosRaw = varint(f, 2) ?? 0n;
  const nanos = nanosRaw > 999_999_999n ? 999_999_999n : nanosRaw;
  return Number(seconds) * 1000 + Number(nanos / 1_000_000n);
};

type Metadata = { model?: string; modelId?: number; provider?: number; usage?: ModelUsage; retries: ModelUsage[]; timestamp?: number };

const parseGenerator = (blob: Uint8Array): Metadata => {
  const chatModel = bytes(decode(blob), 1);
  if (!chatModel) throw new ProtoError("missing chat model field 1");
  const f = decode(chatModel);
  const usageBlob = bytes(f, 4);
  const retries = bytesAll(f, 17)
    .map(parseRetry)
    .filter((u): u is ModelUsage => Boolean(u));
  const info = bytes(f, 9);
  let timestamp: number | undefined;
  if (info) {
    const message = bytes(decode(info), 4);
    timestamp = message ? parseTimestampMessage(message) : undefined;
  }
  return {
    model: text(f, 19) ?? text(f, 21),
    modelId: nonZero(varintNum(f, 3)),
    usage: usageBlob ? parseModelUsage(usageBlob) : undefined,
    retries,
    timestamp,
  };
};

const parseStep = (blob: Uint8Array): Metadata => {
  const f = decode(blob);
  const usageBlob = bytes(f, 9);
  const retries = bytesAll(f, 28)
    .map(parseRetry)
    .filter((u): u is ModelUsage => Boolean(u));
  const infoBlob = bytes(f, 24);
  const info = infoBlob ? decode(infoBlob) : undefined;
  const timestampBlob = bytes(f, 8) ?? bytes(f, 1);
  return {
    model: info ? (text(info, 12) ?? text(info, 8)) : undefined,
    modelId: info ? nonZero(varintNum(info, 1)) : undefined,
    provider: info ? nonZero(varintNum(info, 7)) : undefined,
    usage: usageBlob ? parseModelUsage(usageBlob) : undefined,
    retries,
    timestamp: timestampBlob ? parseTimestampMessage(timestampBlob) : undefined,
  };
};

const ID_MODELS: Record<number, string> = {
  246: "gemini-2.5-pro",
  312: "gemini-2.5-flash",
  313: "gemini-2.5-flash-thinking",
  329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite",
  281: "claude-4-sonnet",
  282: "claude-4-sonnet",
  290: "claude-4-opus",
  291: "claude-4-opus",
  333: "claude-4.5-sonnet",
  334: "claude-4.5-sonnet",
  340: "claude-4.5-haiku",
  341: "claude-4.5-haiku",
  342: "model_openai_gpt_oss_120b_medium",
  1318: "gemini-3.8-flash-high",
  1319: "gemini-3.8-flash-medium",
  1320: "gemini-3.8-flash-low",
  1298: "gemini-3.7-flash-high",
  1299: "gemini-3.7-flash-medium",
  1300: "gemini-3.7-flash-low",
  1071: "gemini-3.6-flash-high",
  1072: "gemini-3.6-flash-medium",
  1073: "gemini-3.6-flash-low",
};

const modelNameFromId = (id: number): string => ID_MODELS[id] ?? (id >= 1000 ? `model_placeholder_m${id - 1000}` : `antigravity-model-${id}`);

const EFFORT_VARIANTS: Record<string, string> = {};
for (const version of ["3.8", "3.7", "3.6"]) for (const effort of ["high", "medium", "low"]) EFFORT_VARIANTS[`gemini ${version} flash (${effort})`] = `gemini-${version}-flash-${effort}`;

const NAMED: [string[], string][] = [
  [["gemini 3.8 flash", "gemini 3.8 flash thinking"], "gemini-3.8-flash"],
  [["gemini 3.7 flash", "gemini 3.7 flash thinking"], "gemini-3.7-flash"],
  [["gemini 3.7 pro", "gemini 3.7 pro thinking"], "gemini-3.7-pro"],
  [["gemini 3.6 flash", "gemini 3 flash"], "gemini-3.6-flash"],
  [["gemini 3.6 pro"], "gemini-3.6-pro"],
  [["gemini 3 pro", "gemini 3 pro thinking"], "gemini-3-pro"],
  [["gemini 2.5 flash"], "gemini-2.5-flash"],
  [["gemini 2.5 pro"], "gemini-2.5-pro"],
  [["gemini 2.0 flash", "gemini 2 flash"], "gemini-2.0-flash"],
  [["gemini 2.0 pro"], "gemini-2.0-pro"],
  [["gemini 1.5 flash"], "gemini-1.5-flash"],
  [["gemini 1.5 pro"], "gemini-1.5-pro"],
  [["model_placeholder_m318"], "gemini-3.8-flash-high"],
  [["model_placeholder_m319"], "gemini-3.8-flash-medium"],
  [["model_placeholder_m320"], "gemini-3.8-flash-low"],
  [["model_placeholder_m298"], "gemini-3.7-flash-high"],
  [["model_placeholder_m299"], "gemini-3.7-flash-medium"],
  [["model_placeholder_m300"], "gemini-3.7-flash-low"],
  [["model_placeholder_m71"], "gemini-3.6-flash-high"],
  [["model_placeholder_m72"], "gemini-3.6-flash-medium"],
  [["model_placeholder_m73"], "gemini-3.6-flash-low"],
  [["model_placeholder_m26"], "claude-opus-4-6"],
  [["model_placeholder_m35"], "claude-sonnet-4-6"],
  [["model_placeholder_m36", "model_placeholder_m37", "model_placeholder_m16"], "gemini-3.1-pro"],
  [["model_placeholder_m18", "model_placeholder_m84", "model_placeholder_m47"], "gemini-3-flash-preview"],
  [["model_placeholder_m132", "model_placeholder_m133"], "gemini-3.5-flash-high"],
  [["model_placeholder_m187"], "gemini-3.5-flash-extra-low"],
  [["model_placeholder_m20"], "gemini-3.5-flash-medium"],
  [["model_openai_gpt_oss_120b_medium"], "gpt-oss-120b-medium"],
  [["gemini-pro-default", "gemini-pro-agent"], "gemini-3.1-pro"],
  [["gemini-3-flash-agent", "gemini-3-flash-agent-a", "gemini-3-flash-agent-b", "gemini-3-flash-a", "gemini-3-flash-b"], "gemini-3.5-flash-high"],
  [["gemini-3-flash-c", "gemini-3-flash"], "gemini-3-flash-preview"],
  [["gemini-3.5-flash-low"], "gemini-3.5-flash-medium"],
  [["gemini-3.1-pro-high", "gemini-3.1-pro-low"], "gemini-3.1-pro"],
  [["gemini-3-pro-high", "gemini-3-pro-low"], "gemini-3-pro"],
  [["claude 3.7 sonnet", "claude 3.7 sonnet thinking"], "claude-3-7-sonnet"],
  [["claude 3.5 sonnet"], "claude-3-5-sonnet"],
  [["claude 3.5 haiku"], "claude-3-5-haiku"],
  [["claude 3 opus"], "claude-3-opus"],
];
const NAMED_MAP = new Map(NAMED.flatMap(([keys, value]) => keys.map((key) => [key, value] as const)));

export const normalizeAntigravityModel = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const effort = EFFORT_VARIANTS[lower];
  if (effort) return effort;
  const paren = lower.indexOf("(");
  const base = paren >= 0 ? lower.slice(0, paren).trim() : lower;
  const named = NAMED_MAP.get(base);
  if (named) return named;
  const converted = base.replaceAll(" ", "-");
  if (converted.startsWith("gemini-") || converted.startsWith("claude-") || converted.startsWith("gpt-")) return converted;
  return trimmed;
};

const flashAlias = (model: string): string | undefined => {
  const match = /^gemini-(3\.[678])-flash-(high|medium|low)$/.exec(model);
  return match ? `gemini-${match[1]}-flash` : undefined;
};

const modelCandidates = (model: string, provider: number | undefined): string[] => {
  const models = [model, ...(flashAlias(model) ? [flashAlias(model)!] : [])];
  const google = provider !== undefined && GOOGLE_PROVIDERS.has(provider);
  return [...new Set(models.flatMap((m) => [m, ...(google ? PROVIDER_PREFIXES.map((p) => `${p}/${m}`) : [])]))];
};

type Event = {
  timestamp: number;
  sessionId: string;
  model: string;
  provider?: number;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  reasoning: number;
  totalOutput: number;
  messageId?: string;
  identities: string[];
  timestampRank: number;
  messageIdRank: number;
};

const identityKeys = (u: ModelUsage): string[] =>
  [u.responseId && `response:${u.responseId}`, u.providerMessageId && `provider:${u.providerMessageId}`, u.messageId && `message:${u.messageId}`].filter(
    (v): v is string => Boolean(v),
  );

const preferredMessageId = (u: ModelUsage): [string | undefined, number] =>
  u.responseId ? [u.responseId, 3] : u.providerMessageId ? [u.providerMessageId, 2] : [u.messageId, 1];

const tokenBearing = (u: ModelUsage) => u.input > 0 || u.totalOutput > 0 || u.cacheCreation > 0 || u.cacheRead > 0 || u.reasoning > 0 || u.visibleOutput > 0;

type Context = { model?: string; provider?: number; timestamp?: [number, number]; trajectory?: number; fallback: number; sessionId: string };

const appendEvent = (events: Event[], identityTimestamps: Map<string, [number, number]>, usage: ModelUsage, ctx: Context) => {
  if (!tokenBearing(usage)) return;
  const [timestamp, rank] =
    ctx.timestamp ??
    identityKeys(usage)
      .map((id) => identityTimestamps.get(id))
      .find((v) => v !== undefined) ??
    (ctx.trajectory !== undefined ? [ctx.trajectory, 1] : [ctx.fallback, 0]);
  const totalOutput = Math.max(usage.totalOutput, usage.visibleOutput + usage.reasoning);
  const output = Math.max(usage.visibleOutput, Math.max(totalOutput - usage.reasoning, 0));
  const reasoning = Math.max(usage.reasoning, Math.max(totalOutput - output, 0));
  const model =
    (usage.modelId !== undefined ? normalizeAntigravityModel(modelNameFromId(usage.modelId)) : undefined) ??
    (ctx.model !== undefined ? normalizeAntigravityModel(ctx.model) : undefined) ??
    DEFAULT_MODEL;
  const [messageId, messageIdRank] = preferredMessageId(usage);
  const identities = identityKeys(usage);
  for (const id of identities) {
    const old = identityTimestamps.get(id);
    if (!old || rank > old[1] || (rank === old[1] && timestamp < old[0])) identityTimestamps.set(id, [timestamp, rank]);
  }
  events.push({
    timestamp,
    sessionId: ctx.sessionId,
    model,
    provider: usage.provider ?? ctx.provider,
    input: usage.input,
    output,
    cacheCreation: usage.cacheCreation,
    cacheRead: usage.cacheRead,
    reasoning,
    totalOutput,
    messageId,
    identities,
    timestampRank: rank,
    messageIdRank,
  });
};

const blobOf = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new ProtoError("unreadable blob column");
};

const metadataModel = (m: Metadata): string | undefined =>
  (m.model !== undefined ? normalizeAntigravityModel(m.model) : undefined) ?? (m.modelId !== undefined ? normalizeAntigravityModel(modelNameFromId(m.modelId)) : undefined);

const parseDatabase = async (path: string): Promise<Event[] | undefined> => {
  let fallback = 0;
  try {
    fallback = Math.floor(statSync(path).mtimeMs);
  } catch {}
  const db = await openReadonly(path);
  if (!db) throw new Error(`Failed to open Antigravity database '${path}'`);
  try {
    const pages = db.all("PRAGMA page_count")[0];
    if (!pages) throw new Error(`Failed to inspect Antigravity database '${path}': page count is unavailable`);
    if (Number(Object.values(pages)[0]) === 0) return undefined;
    const tableExists = (name: string) => db.all(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${name}' LIMIT 1`).length > 0;
    const wrap = <T>(what: string, fn: () => T): T => {
      try {
        return fn();
      } catch (error) {
        throw new Error(`Failed to parse Antigravity ${what} in '${path}': ${(error as Error).message}`);
      }
    };
    const sessionId = basename(path, extname(path)) || "unknown";
    let trajectory: number | undefined;
    if (tableExists("trajectory_metadata_blob")) {
      for (const row of db.all("SELECT data FROM trajectory_metadata_blob ORDER BY rowid ASC")) {
        const candidate = wrap("trajectory metadata", () => {
          const message = bytes(decode(blobOf(row.data)), 2);
          return message ? parseTimestampMessage(message) : undefined;
        });
        if (trajectory === undefined) trajectory = candidate;
      }
    }
    const generations = db.all("SELECT idx, data FROM gen_metadata ORDER BY idx ASC").map((row) => wrap(`metadata row ${row.idx}`, () => parseGenerator(blobOf(row.data))));
    const steps = tableExists("steps")
      ? db.all("SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx ASC").map((row) => wrap(`step metadata row ${row.idx}`, () => parseStep(blobOf(row.metadata))))
      : [];
    const generationModel = [...generations].reverse().map(metadataModel).find((m) => m !== undefined);
    const events: Event[] = [];
    const identityTimestamps = new Map<string, [number, number]>();
    for (const step of steps) {
      const model = metadataModel(step) ?? generationModel;
      const ctx: Context = { model, provider: step.provider, timestamp: step.timestamp !== undefined ? [step.timestamp, 3] : undefined, trajectory, fallback, sessionId };
      if (step.usage) appendEvent(events, identityTimestamps, step.usage, ctx);
      for (const retry of step.retries) appendEvent(events, identityTimestamps, retry, ctx);
    }
    let current: string | undefined;
    for (const generation of generations) {
      const rowModel =
        metadataModel(generation) ?? (generation.usage?.modelId !== undefined ? normalizeAntigravityModel(modelNameFromId(generation.usage.modelId)) : undefined);
      if (rowModel !== undefined) current = rowModel;
      const ctx: Context = { model: current, timestamp: generation.timestamp !== undefined ? [generation.timestamp, 3] : undefined, trajectory, fallback, sessionId };
      if (generation.usage) appendEvent(events, identityTimestamps, generation.usage, ctx);
      for (const retry of generation.retries) appendEvent(events, identityTimestamps, retry, ctx);
    }
    return events;
  } finally {
    db.close();
  }
};

const mergeEvent = (target: Event, duplicate: Event) => {
  target.input = Math.max(target.input, duplicate.input);
  target.output = Math.max(target.output, duplicate.output);
  target.cacheCreation = Math.max(target.cacheCreation, duplicate.cacheCreation);
  target.cacheRead = Math.max(target.cacheRead, duplicate.cacheRead);
  target.reasoning = Math.max(target.reasoning, duplicate.reasoning);
  target.totalOutput = Math.max(target.totalOutput, duplicate.totalOutput, target.output + target.reasoning);
  if (target.model === DEFAULT_MODEL && duplicate.model !== DEFAULT_MODEL) target.model = duplicate.model;
  target.provider ??= duplicate.provider;
  if (duplicate.timestampRank > target.timestampRank || (duplicate.timestampRank === target.timestampRank && duplicate.timestamp < target.timestamp)) {
    target.timestamp = duplicate.timestamp;
    target.timestampRank = duplicate.timestampRank;
  }
  if (duplicate.messageIdRank > target.messageIdRank) {
    target.messageId = duplicate.messageId;
    target.messageIdRank = duplicate.messageIdRank;
  }
  for (const id of duplicate.identities) if (!target.identities.includes(id)) target.identities.push(id);
};

const dedupeEvents = (events: Event[]): Event[] => {
  const slots: (Event | undefined)[] = [];
  const indexes = new Map<string, number>();
  for (const event of events) {
    const matching = [...new Set(event.identities.map((id) => indexes.get(id)).filter((v): v is number => v !== undefined))].sort((a, b) => a - b);
    if (matching.length === 0) {
      const index = slots.length;
      for (const id of event.identities) indexes.set(id, index);
      slots.push(event);
      continue;
    }
    const target = matching[0]!;
    for (const duplicate of matching.slice(1)) {
      const taken = slots[duplicate];
      slots[duplicate] = undefined;
      if (taken) mergeEvent(slots[target]!, taken);
    }
    mergeEvent(slots[target]!, event);
    for (const id of slots[target]!.identities) indexes.set(id, target);
  }
  return slots.filter((e): e is Event => Boolean(e));
};

const toEntry = (e: Event): UsageEntry => {
  const candidates = modelCandidates(e.model, e.provider);
  const exact = flashAlias(e.model) !== undefined;
  return {
    agent: "antigravity",
    timestamp: e.timestamp,
    sessionId: e.sessionId,
    projectPath: "Antigravity",
    model: e.model,
    inputTokens: e.input,
    outputTokens: e.output,
    cacheCreationTokens: e.cacheCreation,
    cacheReadTokens: e.cacheRead,
    extraTotalTokens: Math.max(e.totalOutput - e.output, 0),
    extraBilledAsOutput: true,
    reasoningOutputTokens: e.reasoning,
    ...(exact ? { exactPricingCandidates: candidates, pricingCandidates: [], pricingIgnoresTimestamp: true } : { pricingCandidates: candidates }),
    candidateRule: "first-found",
  };
};

export const antigravity: Adapter = {
  id: "antigravity",
  label: "Antigravity",
  product: "Antigravity",
  envVars: ["ANTIGRAVITY_DATA_DIR"],
  reports: ["daily", "monthly", "session"],
  sessionStyle: "entries-with-activity",
  hasData: () => antigravityDbPaths().length > 0,
  async load(ctx): Promise<UsageEntry[]> {
    const parsed: Event[] = [];
    for (const path of antigravityDbPaths()) {
      const events = await parseDatabase(path);
      if (events) parsed.push(...events);
      else if (ctx.debug) ctx.warn(`Skipping uninitialized Antigravity database '${path}': empty SQLite snapshot`);
    }
    return dedupeEvents(parsed)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(toEntry);
  },
};
