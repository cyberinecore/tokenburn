import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { envPaths, home, isDir, listDir, walk } from "../core/fs.ts";
import { lenientUint } from "../core/tokens.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";

type Obj = Record<string, any>;

export const commandCodeHomes = (): string[] => {
  const candidates = process.env.COMMANDCODE_HOME !== undefined ? envPaths("COMMANDCODE_HOME") : [join(home(), ".commandcode")];
  return [...new Set(candidates)].filter(isDir);
};

export const commandCodeJobDirs = (): string[] => {
  const candidates =
    process.env.COMMANDCODE_JOBS_DIR !== undefined ? envPaths("COMMANDCODE_JOBS_DIR") : [join(home(), ".local", "share", "nf-commandcode", "jobs")];
  return [...new Set(candidates)].filter(isDir);
};

const pricingCandidates = (model: string): string[] => {
  const base = model.replace(/:[a-z0-9-]+$/i, "");
  const bare = base.includes("/") ? base.slice(base.lastIndexOf("/") + 1) : base;
  return [...new Set([base, base.toLowerCase(), bare, bare.toLowerCase()])];
};

const isFreeModel = (model: string) => /[:-]free$/i.test(model);

const buildEntry = (
  usage: Obj,
  model: string,
  timestamp: number,
  sessionId: string,
  projectPath: string,
  recordedCost: number | undefined,
): UsageEntry | undefined => {
  const rawInput = lenientUint(usage.inputTokens);
  const output = lenientUint(usage.outputTokens);
  const cacheRead = Math.min(lenientUint(usage.cacheReadTokens), rawInput);
  const cacheWrite = Math.min(lenientUint(usage.cacheWriteTokens), Math.max(rawInput - cacheRead, 0));
  const input = Math.max(rawInput - cacheRead - cacheWrite, 0);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
  return {
    agent: "commandcode",
    timestamp,
    sessionId,
    projectPath,
    model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    extraTotalTokens: 0,
    costUSD: recordedCost ?? (isFreeModel(model) ? 0 : undefined),
    pricingCandidates: pricingCandidates(model),
  };
};

const readLines = (file: string): string[] => {
  try {
    return readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
};

const parseTranscript = (file: string): UsageEntry[] => {
  const sessionId = basename(file, ".jsonl");
  let projectPath = basename(dirname(file));
  const out: UsageEntry[] = [];
  const seen = new Set<string>();
  for (const line of readLines(file)) {
    if (!line.includes('"usage"') && !line.includes('"session"')) continue;
    let value: Obj;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value?.type === "session" && typeof value.cwd === "string" && value.cwd) {
      projectPath = value.cwd;
      continue;
    }
    if (value?.type !== "message" || !value.usage || typeof value.usage !== "object") continue;
    const id = typeof value.id === "string" ? value.id : undefined;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const timestamp = Date.parse(value.timestamp ?? value.message?.meta?.createdAt);
    if (Number.isNaN(timestamp)) continue;
    const model = typeof value.model === "string" && value.model ? value.model : "unknown";
    const cost = typeof value.usage.costUsd === "number" && Number.isFinite(value.usage.costUsd) ? value.usage.costUsd : undefined;
    const entry = buildEntry(value.usage, model, timestamp, sessionId, projectPath, cost);
    if (entry) out.push(entry);
  }
  return out;
};

const readJson = (file: string): Obj | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

const parseJob = (dir: string): { sessionId?: string; entries: UsageEntry[] } => {
  const meta = readJson(join(dir, "meta.json")) ?? {};
  const stdout = join(dir, "stdout.jsonl");
  const events: { model: string; usage: Obj }[] = [];
  let result: Obj | undefined;
  for (const line of readLines(stdout)) {
    if (!line.includes('"model_request_end"') && !line.includes('"type":"result"')) continue;
    let value: Obj;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value?.type === "result") result = value;
    else if (value?.type === "event" && value.event?.type === "model_request_end" && value.event.usage) {
      events.push({ model: typeof value.event.model === "string" && value.event.model ? value.event.model : String(meta.model ?? "unknown"), usage: value.event.usage });
    }
  }
  const sessionId = typeof result?.sessionId === "string" ? result.sessionId : typeof meta.sessionId === "string" ? meta.sessionId : basename(dir);
  let timestamp = Date.parse(meta.startedAt ?? meta.finishedAt);
  if (Number.isNaN(timestamp)) {
    try {
      timestamp = Math.floor(statSync(stdout).mtimeMs);
    } catch {
      return { entries: [] };
    }
  }
  const projectPath = typeof meta.workspace === "string" && meta.workspace ? meta.workspace : "Command Code";
  const sources = events.length ? events : result?.usage ? [{ model: String(meta.model ?? "unknown"), usage: result.usage }] : [];
  const entries = sources
    .map(({ model, usage }) => buildEntry(usage, model, timestamp, sessionId, projectPath, meta.free === true ? 0 : undefined))
    .filter((e): e is UsageEntry => Boolean(e));
  return { sessionId, entries };
};

const transcriptFiles = (): string[] => {
  const files: string[] = [];
  for (const root of commandCodeHomes()) {
    for (const file of walk(join(root, "projects"), (name) => name.endsWith(".jsonl") && !name.endsWith(".checkpoints.jsonl"))) files.push(file);
  }
  return files.sort();
};

const jobDirs = (): string[] =>
  commandCodeJobDirs()
    .flatMap((root) => listDir(root).map((name) => join(root, name)))
    .filter(isDir)
    .sort();

export const commandcode: Adapter = {
  id: "commandcode",
  label: "Command Code",
  product: "Command Code",
  envVars: ["COMMANDCODE_HOME", "COMMANDCODE_JOBS_DIR"],
  reports: ["daily", "weekly", "monthly", "session"],
  sessionStyle: "generic-with-activity",
  hasData: () => transcriptFiles().length > 0 || jobDirs().length > 0,
  async load(): Promise<UsageEntry[]> {
    const entries: UsageEntry[] = [];
    const transcriptSessions = new Set<string>();
    for (const file of transcriptFiles()) {
      const parsed = parseTranscript(file);
      if (parsed.length) transcriptSessions.add(basename(file, ".jsonl"));
      entries.push(...parsed);
    }
    for (const dir of jobDirs()) {
      const job = parseJob(dir);
      if (job.sessionId && transcriptSessions.has(job.sessionId)) continue;
      entries.push(...job.entries);
    }
    return entries.sort((a, b) => a.timestamp - b.timestamp);
  },
};
