import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { envOrDefaultDirs, filesWithExtension, isObj, nonEmpty, type Obj, parseTsTimestamp, readJson, readText, tokenEntry, u64 } from "./common.ts";

const SUFFIX = ".settings.json";

export const droidRoots = (): string[] => envOrDefaultDirs("DROID_SESSIONS_DIR", (h) => [join(h, ".factory", "sessions")]);

const settingsFiles = (): string[] =>
  droidRoots()
    .flatMap((root) => filesWithExtension(root, "json"))
    .filter((file) => basename(file).endsWith(SUFFIX));

export const normalizeDroidModelName = (model: string): string => {
  const raw = model.startsWith("custom:") ? model.slice("custom:".length) : model;
  let withoutBrackets = "";
  let depth = 0;
  for (const ch of raw) {
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(depth - 1, 0);
    else if (depth === 0) withoutBrackets += ch;
  }
  const lower = withoutBrackets.trim().replace(/-+$/, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
  let normalized = "";
  let previousDash = false;
  for (const ch of lower) {
    const next = ch === "." || /\s/u.test(ch) || ch === "-" ? "-" : ch;
    if (next === "-") {
      if (!previousDash) {
        normalized += "-";
        previousDash = true;
      }
    } else {
      normalized += next;
      previousDash = false;
    }
  }
  return normalized.replace(/^-+|-+$/g, "");
};

const normalizeProvider = (value: string | undefined): string => {
  if (value === undefined) return "unknown";
  const normalized = value.trim().replace(/[A-Z]/g, (c) => c.toLowerCase()).replaceAll("-", "_");
  if (normalized === "") return "unknown";
  if (normalized === "claude" || normalized === "anthropic") return "anthropic";
  if (["google", "google_ai", "gemini", "vertex", "vertex_ai"].includes(normalized)) return "google";
  if (["xai", "x_ai", "grok"].includes(normalized)) return "xai";
  return normalized;
};

const inferProvider = (model: string): string => {
  if (model.includes("claude") || model.includes("opus") || model.includes("sonnet") || model.includes("haiku")) return "anthropic";
  if (model.startsWith("gpt-") || model.includes("-gpt-") || model.includes("chatgpt") || /^o\d/.test(model)) return "openai";
  if (model.includes("gemini")) return "google";
  if (model.includes("grok")) return "xai";
  return "unknown";
};

const defaultModel = (provider: string): string =>
  ({ anthropic: "claude-unknown", openai: "gpt-unknown", google: "gemini-unknown", xai: "grok-unknown" })[provider] ?? "unknown";

const providerPrefixes = (provider: string): string[] => {
  if (provider === "anthropic") return ["anthropic/", "openrouter/anthropic/"];
  if (provider === "openai") return ["openai/", "openrouter/openai/"];
  if (provider === "google") return ["google/", "vertex_ai/", "openrouter/google/"];
  if (provider === "xai") return ["xai/", "openrouter/x-ai/"];
  if (provider === "unknown") return [];
  return [`${provider}/`, `openrouter/${provider}/`];
};

const sidecarModel = (settingsPath: string): string | undefined => {
  const prefix = basename(settingsPath).slice(0, -SUFFIX.length);
  const content = readText(join(dirname(settingsPath), `${prefix}.jsonl`));
  if (content === undefined) return undefined;
  for (const line of content.split(/\r?\n/).slice(0, 500)) {
    const at = line.indexOf("Model:");
    if (at < 0) continue;
    const raw = line.slice(at + "Model:".length).split(/["\\[]/)[0]!.trim();
    if (!raw) continue;
    const normalized = normalizeDroidModelName(raw);
    if (normalized) return normalized;
  }
  return undefined;
};

type DroidEntry = UsageEntry & { order: number };

const parseSettings = (file: string, order: number): DroidEntry | undefined => {
  const settings = readJson(file);
  if (!isObj(settings) || !isObj(settings.tokenUsage)) return undefined;
  const usage: Obj = settings.tokenUsage;
  const configuredProvider = normalizeProvider(nonEmpty(settings.providerLock));
  const configuredModel = nonEmpty(settings.model);
  let model = configuredModel !== undefined ? normalizeDroidModelName(configuredModel) : (sidecarModel(file) ?? defaultModel(configuredProvider));
  if (!model) model = defaultModel(configuredProvider);
  const provider = configuredProvider === "unknown" ? inferProvider(model) : configuredProvider;
  const lockText = nonEmpty(settings.providerLockTimestamp);
  const lockTimestamp = lockText === undefined ? undefined : parseTsTimestamp(lockText);
  let timestamp = lockTimestamp;
  if (timestamp === undefined) {
    try {
      timestamp = Math.floor(statSync(file).mtimeMs);
    } catch {
      return undefined;
    }
  }
  const sessionId = basename(file).slice(0, -SUFFIX.length) || "unknown";
  const entry = tokenEntry(
    {
      agent: "droid",
      timestamp,
      sessionId,
      projectPath: "Droid",
      model,
      extraBilledAsOutput: true,
      pricingCandidates: [...new Set([model, ...providerPrefixes(provider).map((prefix) => `${prefix}${model}`)])],
      pricingIgnoresTimestamp: lockTimestamp === undefined,
    },
    { input: u64(usage.inputTokens), output: u64(usage.outputTokens), cacheCreation: u64(usage.cacheCreationTokens), cacheRead: u64(usage.cacheReadTokens) },
    u64(usage.totalTokens),
    u64(usage.thinkingTokens),
  );
  return entry && { ...entry, order };
};

export const droid: Adapter = {
  id: "droid",
  label: "Droid",
  product: "Droid",
  envVars: ["DROID_SESSIONS_DIR"],
  reports: ["daily", "monthly", "session"],
  hasData: () => settingsFiles().length > 0,
  async load(): Promise<UsageEntry[]> {
    const parsed = settingsFiles()
      .sort()
      .map((file, order) => parseSettings(file, order))
      .filter((entry): entry is DroidEntry => Boolean(entry))
      .sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);
    const seen = new Set<string>();
    const entries: UsageEntry[] = [];
    for (const { order: _, ...entry } of parsed.reverse()) {
      if (seen.has(entry.sessionId)) continue;
      seen.add(entry.sessionId);
      entries.push(entry);
    }
    return entries.reverse();
  },
};
