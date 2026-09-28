import { readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { envPaths, home, isDir, walk } from "../core/fs.ts";
import { applyTotalTokenFallback, lenientUint } from "../core/tokens.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";

export const qwenRoots = (): string[] => {
  const candidates = process.env.QWEN_DATA_DIR !== undefined ? envPaths("QWEN_DATA_DIR") : [join(home(), ".qwen")];
  return [...new Set(candidates)].filter(isDir);
};

const chatFiles = (): { file: string; project: string }[] => {
  const out: { file: string; project: string }[] = [];
  for (const root of qwenRoots()) {
    const projects = join(root, "projects");
    if (!isDir(projects)) continue;
    for (const file of walk(projects, (n) => n.endsWith(".jsonl"))) {
      const parts = relative(projects, file).split(sep);
      if (parts.length === 3 && parts[0] && parts[1] === "chats") out.push({ file, project: parts[0] });
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
};

const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

type QwenEntry = UsageEntry & { fingerprint: string };

const parseFile = (file: string, project: string): QwenEntry[] => {
  let content: string;
  let fallback = 0;
  try {
    content = readFileSync(file, "utf8");
    fallback = Math.floor(statSync(file).mtimeMs);
  } catch {
    return [];
  }
  const out: QwenEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.includes('"usageMetadata"')) continue;
    let record: Record<string, any>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || record.type !== "assistant") continue;
    const usage = record.usageMetadata;
    if (!usage || typeof usage !== "object") continue;
    const { usage: display, extra } = applyTotalTokenFallback(
      { input: lenientUint(usage.promptTokenCount), output: lenientUint(usage.candidatesTokenCount), cacheCreation: 0, cacheRead: lenientUint(usage.cachedContentTokenCount) },
      lenientUint(usage.thoughtsTokenCount),
      lenientUint(usage.totalTokenCount),
    );
    if (display.input === 0 && display.output === 0 && display.cacheRead === 0 && extra === 0) continue;
    const text = nonEmpty(record.timestamp);
    const parsed = text ? Date.parse(text) : NaN;
    const timestamp = Number.isNaN(parsed) ? fallback : parsed;
    const timestampText = !Number.isNaN(parsed) ? text! : new Date(fallback).toISOString();
    const sessionId = nonEmpty(record.sessionId) ?? `${project}-${basename(file, ".jsonl")}`;
    const model = nonEmpty(record.model) ?? "unknown";
    out.push({
      agent: "qwen",
      timestamp,
      sessionId,
      projectPath: project,
      model,
      inputTokens: display.input,
      outputTokens: display.output,
      cacheCreationTokens: 0,
      cacheReadTokens: display.cacheRead,
      extraTotalTokens: extra,
      extraBilledAsOutput: true,
      pricingCandidates: [model, `qwen/${model}`, `alibaba/${model}`],
      candidateRule: "first-found",
      fingerprint: JSON.stringify([sessionId, timestampText, model, display.input, display.output, display.cacheRead, extra]),
    });
  }
  return out;
};

export const qwen: Adapter = {
  id: "qwen",
  label: "Qwen",
  product: "Qwen",
  envVars: ["QWEN_DATA_DIR"],
  reports: ["daily", "monthly", "session"],
  sessionStyle: "generic-with-activity",
  emptyTotalsNull: true,
  hasData: () => chatFiles().length > 0,
  async load(): Promise<UsageEntry[]> {
    const seen = new Set<string>();
    const entries: QwenEntry[] = [];
    for (const { file, project } of chatFiles()) {
      for (const entry of parseFile(file, project)) {
        if (seen.has(entry.fingerprint)) continue;
        seen.add(entry.fingerprint);
        entries.push(entry);
      }
    }
    return entries.sort((a, b) => a.timestamp - b.timestamp);
  },
};
