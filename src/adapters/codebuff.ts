import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { envPaths, home, isDir } from "../core/fs.ts";
import { applyTotalTokenFallback } from "../core/tokens.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { filesWithExtension, isObj, nonEmpty, type Obj, parseTsTimestamp, readJson } from "./common.ts";

const CHANNELS = ["manicode", "manicode-dev", "manicode-staging"];
const DEFAULT_MODEL = "codebuff-unknown";

export const codebuffProjectRoots = (): string[] => {
  const roots = process.env.CODEBUFF_DATA_DIR !== undefined ? envPaths("CODEBUFF_DATA_DIR") : CHANNELS.map((channel) => join(home(), ".config", channel));
  return [...new Set(roots.map((root) => (basename(root) === "projects" ? root : join(root, "projects"))))].filter(isDir);
};

const chatFiles = (): string[] => codebuffProjectRoots().flatMap((root) => filesWithExtension(root, "json").filter((file) => basename(file) === "chat-messages.json"));

type Usage = { model?: string; credits: number; input: number; output: number; cacheCreation: number; cacheRead: number; extra: number };

const emptyUsage = (): Usage => ({ credits: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, extra: 0 });

const positiveU64 = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

const pick = (record: Obj, keys: string[]): number => {
  for (const key of keys) {
    if (!(key in record)) continue;
    const value = positiveU64(record[key]);
    if (value !== undefined) return value;
  }
  return 0;
};

const pickNested = (record: Obj, key: string, keys: string[]): number => (isObj(record[key]) ? pick(record[key], keys) : 0);

const numberField = (record: Obj, key: string): number => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
};

const parseUsageObject = (value: unknown): Usage => {
  const usage = emptyUsage();
  if (!isObj(value)) return usage;
  const tokens = {
    input: pick(value, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]),
    output: pick(value, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]),
    cacheRead: Math.max(
      pick(value, ["cacheReadInputTokens", "cache_read_input_tokens"]),
      pickNested(value, "promptTokensDetails", ["cachedTokens"]),
      pickNested(value, "prompt_tokens_details", ["cached_tokens"]),
    ),
    cacheCreation: pick(value, [
      "cacheCreationInputTokens",
      "cache_creation_input_tokens",
      "cacheCreationTokens",
      "cache_creation_tokens",
      "cachedTokensCreated",
      "cached_tokens_created",
    ]),
  };
  const { usage: filled, extra } = applyTotalTokenFallback(tokens, 0, pick(value, ["totalTokens", "total_tokens", "total"]));
  return { ...filled, extra, credits: numberField(value, "credits"), model: nonEmpty(value.model) };
};

const mergeFallback = (target: Usage, fallback: Usage): void => {
  if (target.input === 0) target.input = fallback.input;
  if (target.output === 0) target.output = fallback.output;
  if (target.cacheCreation === 0) target.cacheCreation = fallback.cacheCreation;
  if (target.cacheRead === 0) target.cacheRead = fallback.cacheRead;
  if (target.extra === 0) target.extra = fallback.extra;
  if (target.credits <= 0) target.credits = fallback.credits;
  if (target.model === undefined) target.model = fallback.model;
};

const hasSignal = (u: Usage) => u.input > 0 || u.output > 0 || u.cacheCreation > 0 || u.cacheRead > 0 || u.extra > 0 || u.credits > 0;

const runStateUsage = (metadata: Obj): Usage | undefined => {
  const history = metadata.runState?.sessionState?.mainAgentState?.messageHistory;
  if (!Array.isArray(history)) return undefined;
  const usage = emptyUsage();
  let found = false;
  for (const item of [...history].reverse()) {
    if (!isObj(item) || nonEmpty(item.role) !== "assistant" || !isObj(item.providerOptions)) continue;
    const options = item.providerOptions;
    const entryUsage = emptyUsage();
    mergeFallback(entryUsage, parseUsageObject(options.usage));
    if (isObj(options.codebuff)) {
      mergeFallback(entryUsage, parseUsageObject(options.codebuff.usage));
      entryUsage.model = nonEmpty(options.codebuff.model) ?? entryUsage.model;
    }
    if (hasSignal(entryUsage) || entryUsage.model !== undefined) found = true;
    mergeFallback(usage, entryUsage);
  }
  return found ? usage : undefined;
};

const assistantUsage = (message: Obj): Usage => {
  const usage = emptyUsage();
  if (isObj(message.metadata)) {
    const metadata = message.metadata;
    usage.model = nonEmpty(metadata.model);
    mergeFallback(usage, parseUsageObject(metadata.usage));
    mergeFallback(usage, parseUsageObject(isObj(metadata.codebuff) ? metadata.codebuff.usage : undefined));
    const fromRunState = runStateUsage(metadata);
    if (fromRunState) mergeFallback(usage, fromRunState);
  }
  const credits = numberField(message, "credits");
  if (credits > 0 && usage.credits <= 0) usage.credits = credits;
  return usage;
};

const timestampValue = (value: unknown): number | undefined => {
  if (typeof value === "string") return parseTsTimestamp(value);
  if (typeof value === "number" && Number.isInteger(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    return millis > 0 ? millis : undefined;
  }
  return undefined;
};

const messageTimestamp = (message: Obj): number | undefined =>
  timestampValue(message.timestamp) ?? timestampValue(message.createdAt) ?? (isObj(message.metadata) ? timestampValue(message.metadata.timestamp) : undefined);

const chatIdTimestamp = (chatId: string): number | undefined => {
  const at = chatId.indexOf("T");
  if (at < 0) return undefined;
  let time = chatId.slice(at + 1);
  for (let i = 0; i < 2; i++) time = time.replace("-", ":");
  return parseTsTimestamp(`${chatId.slice(0, at)}T${time}`);
};

const inferProvider = (model: string): string => {
  const m = model.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (m.startsWith("claude-") || m.startsWith("anthropic/") || m.startsWith("anthropic.")) return "anthropic";
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.startsWith("openai/")) return "openai";
  if (m.startsWith("gemini") || m.startsWith("google/")) return "google";
  if (m.startsWith("grok") || m.startsWith("xai/")) return "xai";
  if (m.startsWith("openrouter/")) return "openrouter";
  return "unknown";
};

const nameOr = (path: string, fallback: string) => basename(path) || fallback;

type CodebuffEntry = UsageEntry & { dedupKey: string };

const parseChatFile = (file: string): CodebuffEntry[] => {
  const messages = readJson(file);
  if (!Array.isArray(messages)) return [];
  const chatDir = dirname(file);
  const chatId = nameOr(chatDir, "unknown");
  const projectDir = dirname(dirname(chatDir));
  const project = nameOr(projectDir, "unknown");
  const channel = nameOr(dirname(dirname(projectDir)), "manicode");
  const sessionId = `${channel}/${project}/${chatId}`;
  const chatTimestamp = chatIdTimestamp(chatId);
  let fileTimestamp = 0;
  try {
    fileTimestamp = Math.floor(statSync(file).mtimeMs);
  } catch {}
  const out: CodebuffEntry[] = [];
  messages.forEach((message, ordinal) => {
    if (!isObj(message)) return;
    const role = nonEmpty(message.variant) ?? nonEmpty(message.role);
    if (role !== "ai" && role !== "agent" && role !== "assistant") return;
    const usage = assistantUsage(message);
    if (!hasSignal(usage)) return;
    const timestamp = messageTimestamp(message) ?? chatTimestamp ?? fileTimestamp;
    const model = usage.model ?? DEFAULT_MODEL;
    const provider = inferProvider(model);
    const id = nonEmpty(message.id);
    const dedupKey = id
      ? `codebuff:${sessionId}:${id}`
      : `codebuff:${sessionId}:${new Date(timestamp).toISOString()}:${model}:${ordinal}:${usage.input}:${usage.output}:${usage.cacheRead}:${usage.cacheCreation}:${usage.extra}`;
    const candidates = provider !== "unknown" && !model.startsWith(`${provider}/`) ? [model, `${provider}/${model}`] : [model];
    out.push({
      agent: "codebuff",
      timestamp,
      sessionId,
      projectPath: "Codebuff",
      model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheCreationTokens: usage.cacheCreation,
      cacheReadTokens: usage.cacheRead,
      extraTotalTokens: usage.extra,
      extraBilledAsOutput: true,
      credits: usage.credits > 0 ? usage.credits : undefined,
      pricingCandidates: candidates,
      dedupKey,
    });
  });
  return out;
};

export const codebuff: Adapter = {
  id: "codebuff",
  label: "Codebuff",
  product: "Codebuff",
  envVars: ["CODEBUFF_DATA_DIR"],
  reports: ["daily", "monthly", "session"],
  hasData: () => chatFiles().length > 0,
  async load(): Promise<UsageEntry[]> {
    const deduped = new Map<string, UsageEntry>();
    for (const file of chatFiles().sort()) {
      for (const { dedupKey, ...entry } of parseChatFile(file)) {
        deduped.delete(dedupKey);
        deduped.set(dedupKey, entry);
      }
    }
    return [...deduped.values()].sort((a, b) => a.timestamp - b.timestamp);
  },
};
