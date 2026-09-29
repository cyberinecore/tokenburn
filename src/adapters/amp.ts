import { join } from "node:path";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { byTimestamp, envOrDefaultDirs, f64, filesWithExtension, isObj, nonEmpty, type Obj, parseTsTimestamp, readJson, tokenEntry, u64 } from "./common.ts";

export const ampRoots = (): string[] => envOrDefaultDirs("AMP_DATA_DIR", (h) => [join(h, ".local/share/amp")]);

const threadFiles = (): string[] => ampRoots().flatMap((root) => filesWithExtension(join(root, "threads"), "json"));

const ampEntry = (threadId: string, timestamp: number, model: string, tokens: Obj | undefined, cache: [number, number], total: number, credits: number | undefined): UsageEntry | undefined =>
  tokenEntry(
    {
      agent: "amp",
      timestamp,
      sessionId: threadId,
      projectPath: "Amp",
      model,
      extraBilledAsOutput: true,
      credits,
    },
    { input: u64(tokens?.input), output: u64(tokens?.output), cacheCreation: cache[0], cacheRead: cache[1] },
    total,
  );

const isAssistant = (message: unknown): message is Obj => isObj(message) && message.role === "assistant";

const parseLedger = (events: unknown[], messages: unknown[], threadId: string): UsageEntry[] => {
  const cache = new Map<number, [number, number]>();
  for (const message of messages) {
    if (!isAssistant(message) || !Number.isInteger(message.messageId)) continue;
    const usage = isObj(message.usage) ? message.usage : undefined;
    cache.set(message.messageId, [u64(usage?.cacheCreationInputTokens), u64(usage?.cacheReadInputTokens)]);
  }
  const out: UsageEntry[] = [];
  for (const event of events) {
    if (!isObj(event)) continue;
    const text = nonEmpty(event.timestamp);
    const timestamp = text === undefined ? undefined : parseTsTimestamp(text);
    const model = nonEmpty(event.model);
    if (timestamp === undefined || model === undefined || event.tokens === undefined || event.tokens === null) continue;
    const tokens = isObj(event.tokens) ? event.tokens : undefined;
    const pair = Number.isInteger(event.toMessageId) ? (cache.get(event.toMessageId) ?? [0, 0]) : [0, 0];
    const entry = ampEntry(threadId, timestamp, model, tokens, pair as [number, number], u64(tokens?.total), f64(event.credits));
    if (entry) out.push(entry);
  }
  return out;
};

const parseMessages = (messages: unknown[], threadId: string): UsageEntry[] => {
  const out: UsageEntry[] = [];
  for (const message of messages) {
    if (!isAssistant(message) || !isObj(message.usage)) continue;
    const usage = message.usage;
    const text = nonEmpty(usage.timestamp) ?? nonEmpty(message.timestamp);
    const timestamp = text === undefined ? undefined : parseTsTimestamp(text);
    const model = nonEmpty(usage.model) ?? nonEmpty(message.model);
    if (timestamp === undefined || model === undefined) continue;
    const entry = ampEntry(
      threadId,
      timestamp,
      model,
      { input: usage.inputTokens, output: usage.outputTokens },
      [u64(usage.cacheCreationInputTokens), u64(usage.cacheReadInputTokens)],
      u64(usage.totalTokens),
      f64(usage.credits),
    );
    if (entry) out.push(entry);
  }
  return out;
};

export const parseThreadFile = (file: string): UsageEntry[] => {
  const thread = readJson(file);
  if (!isObj(thread)) return [];
  const threadId = nonEmpty(thread.id);
  if (!threadId) return [];
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const events = isObj(thread.usageLedger) && Array.isArray(thread.usageLedger.events) ? thread.usageLedger.events : undefined;
  return events ? parseLedger(events, messages, threadId) : parseMessages(messages, threadId);
};

export const amp: Adapter = {
  id: "amp",
  label: "Amp",
  product: "Amp",
  envVars: ["AMP_DATA_DIR"],
  reports: ["daily", "monthly", "session"],
  hasData: () => threadFiles().length > 0,
  async load(): Promise<UsageEntry[]> {
    return threadFiles().flatMap(parseThreadFile).sort(byTimestamp);
  },
};
