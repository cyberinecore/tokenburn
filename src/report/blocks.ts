import type { PricedEntry } from "../core/types.ts";
import { resolveModelAlias } from "../pricing/aliases.ts";

const HOUR = 3_600_000;
const MINUTE = 60_000;
export const WARNING_THRESHOLD = 0.8;

export type SessionBlock = {
  id: string;
  startTime: number;
  endTime: number;
  actualEndTime?: number;
  isActive: boolean;
  isGap: boolean;
  entries: PricedEntry[];
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUSD: number;
  models: string[];
  usageLimitResetTime?: number;
};

export const blockTotal = (b: SessionBlock) => b.inputTokens + b.outputTokens + b.cacheCreationTokens + b.cacheReadTokens;

const floorToHour = (ms: number) => Math.floor(ms / HOUR) * HOUR;

const createBlock = (start: number, entries: PricedEntry[], now: number, duration: number): SessionBlock => {
  const end = start + duration;
  const actualEnd = entries.at(-1)?.timestamp;
  const block: SessionBlock = {
    id: new Date(start).toISOString(),
    startTime: start,
    endTime: end,
    actualEndTime: actualEnd,
    isActive: actualEnd !== undefined && now - actualEnd < duration && now < end,
    isGap: false,
    entries,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0,
    models: [],
  };
  const seen = new Set<string>();
  for (const entry of entries) {
    block.inputTokens += entry.inputTokens;
    block.outputTokens += entry.outputTokens;
    block.cacheCreationTokens += entry.cacheCreationTokens;
    block.cacheReadTokens += entry.cacheReadTokens;
    block.costUSD += entry.cost;
    if (entry.model) {
      const model = resolveModelAlias(entry.model);
      if (!seen.has(model)) {
        seen.add(model);
        block.models.push(model);
      }
    }
    block.usageLimitResetTime ??= entry.usageLimitResetTime;
  }
  return block;
};

const createGapBlock = (last: number, next: number, duration: number): SessionBlock => {
  const start = last + duration;
  return {
    id: `gap-${new Date(start).toISOString()}`,
    startTime: start,
    endTime: next,
    isActive: false,
    isGap: true,
    entries: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0,
    models: [],
  };
};

export const identifySessionBlocks = (input: PricedEntry[], hours: number, now = Date.now()): SessionBlock[] => {
  if (input.length === 0) return [];
  const duration = Math.trunc(hours * HOUR);
  const entries = [...input].sort((a, b) => a.timestamp - b.timestamp);
  const blocks: SessionBlock[] = [];
  let start: number | undefined;
  let current: PricedEntry[] = [];
  for (const entry of entries) {
    if (start !== undefined) {
      const last = current.at(-1)?.timestamp ?? start;
      const sinceStart = entry.timestamp - start;
      const sinceLast = entry.timestamp - last;
      if (sinceStart > duration || sinceLast > duration) {
        blocks.push(createBlock(start, current, now, duration));
        current = [];
        if (sinceLast > duration) blocks.push(createGapBlock(last, entry.timestamp, duration));
        start = floorToHour(entry.timestamp);
      }
    } else start = floorToHour(entry.timestamp);
    current.push(entry);
  }
  if (start !== undefined && current.length) blocks.push(createBlock(start, current, now, duration));
  return blocks;
};

export type BurnRate = { tokensPerMinute: number; tokensPerMinuteForIndicator: number; costPerHour: number };
export type Projection = { totalTokens: number; totalCost: number; remainingMinutes: number };

export const burnRate = (block: SessionBlock): BurnRate | undefined => {
  if (block.isGap || block.entries.length === 0) return undefined;
  const minutes = (block.entries.at(-1)!.timestamp - block.entries[0]!.timestamp) / MINUTE;
  if (minutes <= 0) return undefined;
  return {
    tokensPerMinute: blockTotal(block) / minutes,
    tokensPerMinuteForIndicator: (block.inputTokens + block.outputTokens) / minutes,
    costPerHour: (block.costUSD / minutes) * 60,
  };
};

export const projectBlock = (block: SessionBlock, now = Date.now()): Projection | undefined => {
  if (!block.isActive || block.isGap) return undefined;
  const rate = burnRate(block);
  if (!rate) return undefined;
  const remaining = Math.round((block.endTime - now) / MINUTE);
  return {
    totalTokens: Math.round(blockTotal(block) + rate.tokensPerMinute * remaining),
    totalCost: Math.round((block.costUSD + (rate.costPerHour / 60) * remaining) * 100) / 100,
    remainingMinutes: Math.max(remaining, 0),
  };
};

export const parseTokenLimit = (value: string | undefined, maxTokens: number): number | undefined => {
  if (value === undefined || value === "" || value === "max") return maxTokens > 0 ? maxTokens : undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

export const blockJson = (block: SessionBlock, tokenLimit: string | undefined, maxTokens: number): Record<string, unknown> => {
  const rate = block.isActive ? burnRate(block) : undefined;
  const projection = block.isActive ? projectBlock(block) : undefined;
  const value: Record<string, unknown> = {
    id: block.id,
    startTime: new Date(block.startTime).toISOString(),
    endTime: new Date(block.endTime).toISOString(),
    actualEndTime: block.actualEndTime !== undefined ? new Date(block.actualEndTime).toISOString() : null,
    isActive: block.isActive,
    isGap: block.isGap,
    entries: block.entries.length,
    tokenCounts: {
      inputTokens: block.inputTokens,
      outputTokens: block.outputTokens,
      cacheCreationInputTokens: block.cacheCreationTokens,
      cacheReadInputTokens: block.cacheReadTokens,
    },
    totalTokens: blockTotal(block),
    costUSD: block.costUSD,
    models: block.models,
    burnRate: rate ?? null,
    projection: projection ?? null,
  };
  if (projection && tokenLimit !== undefined) {
    const limit = parseTokenLimit(tokenLimit, maxTokens);
    if (limit !== undefined) {
      value.tokenLimitStatus = {
        limit,
        projectedUsage: projection.totalTokens,
        percentUsed: (projection.totalTokens / limit) * 100,
        status: projection.totalTokens > limit ? "exceeds" : projection.totalTokens > limit * WARNING_THRESHOLD ? "warning" : "ok",
      };
    }
  }
  if (block.usageLimitResetTime !== undefined) value.usageLimitResetTime = new Date(block.usageLimitResetTime).toISOString();
  return value;
};
