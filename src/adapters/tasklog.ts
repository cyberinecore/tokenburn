import { basename, join } from "node:path";
import { isDir, listDir } from "../core/fs.ts";
import type { UsageEntry } from "../core/types.ts";
import { isObj, nonEmpty, type Obj, readJson } from "./common.ts";

export const taskDirs = (tasksRoot: string): string[] =>
  listDir(tasksRoot)
    .map((name) => join(tasksRoot, name))
    .filter((dir) => isDir(dir))
    .sort();

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);

type ModelSwitch = { ts: number; model: string; provider?: string };

const modelSwitches = (dir: string): ModelSwitch[] => {
  const meta = readJson(join(dir, "task_metadata.json"));
  if (!isObj(meta) || !Array.isArray(meta.model_usage)) return [];
  return meta.model_usage
    .filter(isObj)
    .map((u: Obj) => ({ ts: typeof u.ts === "number" ? u.ts : 0, model: nonEmpty(u.model_id) ?? "", provider: nonEmpty(u.model_provider_id) }))
    .filter((u) => u.model)
    .sort((a, b) => a.ts - b.ts);
};

const pricingCandidates = (model: string, provider: string | undefined): string[] => [...new Set([model, ...(provider ? [`${provider}/${model}`] : [])])];

export const parseTaskDir = (dir: string, agent: string, projectPath: string): UsageEntry[] => {
  const messages = readJson(join(dir, "ui_messages.json"));
  if (!Array.isArray(messages)) return [];
  const switches = modelSwitches(dir);
  const sessionId = basename(dir);
  const out: UsageEntry[] = [];
  for (const message of messages) {
    if (!isObj(message) || message.type !== "say" || message.say !== "api_req_started" || typeof message.text !== "string") continue;
    let request: unknown;
    try {
      request = JSON.parse(message.text);
    } catch {
      continue;
    }
    if (!isObj(request) || typeof request.tokensIn !== "number" || typeof request.tokensOut !== "number") continue;
    const timestamp = typeof message.ts === "number" && Number.isFinite(message.ts) ? message.ts : undefined;
    if (timestamp === undefined) continue;
    const info = isObj(message.modelInfo) ? message.modelInfo : undefined;
    const fallback = [...switches].reverse().find((s) => s.ts <= timestamp) ?? switches[0];
    const model = nonEmpty(info?.modelId) ?? fallback?.model ?? "unknown";
    const provider = nonEmpty(info?.providerId) ?? fallback?.provider;
    const input = count(request.tokensIn);
    const output = count(request.tokensOut);
    const cacheCreation = count(request.cacheWrites);
    const cacheRead = count(request.cacheReads);
    if (input + output + cacheCreation + cacheRead === 0) continue;
    const cost = typeof request.cost === "number" && Number.isFinite(request.cost) && request.cost > 0 ? request.cost : undefined;
    out.push({
      agent,
      timestamp,
      sessionId,
      projectPath,
      model,
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: cacheCreation,
      cacheReadTokens: cacheRead,
      extraTotalTokens: 0,
      costUSD: cost,
      pricingCandidates: pricingCandidates(model, provider),
    });
  }
  return out;
};

export const parseClineCliSession = (dir: string, agent: string, projectPath: string): UsageEntry[] => {
  const id = basename(dir);
  const file = readJson(join(dir, `${id}.messages.json`));
  if (!isObj(file) || !Array.isArray(file.messages)) return [];
  const manifest = readJson(join(dir, `${id}.json`));
  const meta = isObj(manifest) ? manifest : {};
  const sessionId = nonEmpty(file.sessionId) ?? nonEmpty(meta.session_id) ?? id;
  const workspace = nonEmpty(meta.workspace_root) ?? nonEmpty(meta.cwd) ?? projectPath;
  const out: UsageEntry[] = [];
  for (const message of file.messages) {
    if (!isObj(message) || !isObj(message.metrics)) continue;
    const metrics = message.metrics;
    const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN);
    const cacheRead = count(num(metrics.cacheReadTokens));
    const cacheCreation = count(num(metrics.cacheWriteTokens));
    const rawInput = count(num(metrics.inputTokens));
    const input = Math.max(rawInput - cacheRead - cacheCreation, 0);
    const output = count(num(metrics.outputTokens));
    const costValue = num(metrics.cost);
    const hasCost = Number.isFinite(costValue);
    if (input + output + cacheRead + cacheCreation === 0 && !hasCost) continue;
    const timestamp = typeof message.ts === "number" ? message.ts : typeof message.ts === "string" ? Date.parse(message.ts) : NaN;
    if (!Number.isFinite(timestamp)) continue;
    const info = isObj(message.modelInfo) ? message.modelInfo : undefined;
    const model = nonEmpty(info?.id) ?? nonEmpty(meta.model) ?? "unknown";
    const provider = nonEmpty(info?.provider) ?? nonEmpty(meta.provider);
    out.push({
      agent,
      timestamp,
      sessionId,
      projectPath: workspace,
      model,
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: cacheCreation,
      cacheReadTokens: cacheRead,
      extraTotalTokens: 0,
      costUSD: hasCost && costValue > 0 ? costValue : undefined,
      recordedZeroCost: hasCost && costValue === 0 ? true : undefined,
      pricingCandidates: pricingCandidates(model, provider),
    });
  }
  return out;
};
