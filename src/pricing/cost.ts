import type { CostMode, PricedEntry, UsageEntry } from "../core/types.ts";
import { costFromPricing, type Pricing, type PricingEngine } from "./pricing.ts";

const baseCandidates = (entry: UsageEntry): string[] =>
  entry.pricingCandidates ?? (entry.pricingModel ?? entry.model ? [entry.pricingModel ?? entry.model!] : []);

const candidatesOf = (entry: UsageEntry, engine: PricingEngine): string[] => {
  if (!entry.exactPricingCandidates && !entry.overridePricingCandidates) return baseCandidates(entry);
  const overrides = entry.overridePricingCandidates?.filter((c) => engine.hasOverride(c)) ?? [];
  const exact = entry.exactPricingCandidates?.filter((c) => engine.findExact(c)) ?? [];
  return [...new Set([...overrides, ...exact, ...baseCandidates(entry)])];
};

const findPricing = (engine: PricingEngine, entry: UsageEntry, candidate: string): Pricing | undefined =>
  entry.pricingIgnoresTimestamp ? engine.find(candidate) : engine.findAt(candidate, entry.timestamp);

const billedTokens = (entry: UsageEntry) => ({
  inputTokens: entry.inputTokens + (entry.cacheCreationBilledAsInput ? entry.cacheCreationTokens : 0),
  outputTokens: entry.outputTokens + (entry.extraBilledAsOutput ? (entry.billedExtraOutputTokens ?? entry.extraTotalTokens) : 0),
  cacheCreationTokens: entry.cacheCreationBilledAsInput ? 0 : entry.cacheCreationTokens,
  cacheReadTokens: entry.cacheReadTokens,
  cacheCreation1hTokens: entry.cacheCreation1hTokens,
});

const codexCost = (entry: UsageEntry, pricing: Pricing, engine: PricingEngine): number => {
  const long = (entry.requestInputTokens ?? 0) > engine.longContextSplitThreshold(entry.model!);
  const cacheRead = pricing.cacheReadExplicit ? pricing.cacheRead : pricing.input;
  const longInput = pricing.inputAbove200k ?? pricing.input;
  const longOutput = pricing.outputAbove200k ?? pricing.output;
  const longCacheRead = pricing.cacheReadExplicit ? (pricing.cacheReadAbove200k ?? cacheRead) : longInput;
  const longCacheCreate = pricing.cacheCreateAbove200k ?? pricing.cacheCreate;
  const cost = long
    ? entry.inputTokens * longInput + entry.cacheReadTokens * longCacheRead + entry.cacheCreationTokens * longCacheCreate + entry.outputTokens * longOutput
    : entry.inputTokens * pricing.input + entry.cacheReadTokens * cacheRead + entry.cacheCreationTokens * pricing.cacheCreate + entry.outputTokens * pricing.output;
  return entry.speed === "fast" ? cost + cost * (pricing.fastMultiplier - 1) : cost;
};

export const calculateCost = (entry: UsageEntry, engine: PricingEngine): number | undefined => {
  if (!entry.model && !entry.pricingCandidates) return 0;
  let found = false;
  for (const candidate of candidatesOf(entry, engine)) {
    const pricing = findPricing(engine, entry, candidate);
    if (!pricing) continue;
    found = true;
    const cost =
      entry.costStyle === "codex"
        ? codexCost(entry, pricing, engine)
        : costFromPricing(billedTokens(entry), pricing) * (entry.speed === "fast" ? pricing.fastMultiplier : 1);
    if (cost > 0 || entry.candidateRule === "first-found") return cost;
  }
  return found ? 0 : undefined;
};

const totalTokens = (e: UsageEntry) =>
  e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens + (e.billedExtraOutputTokens ?? e.extraTotalTokens);

export const priceEntry = (entry: UsageEntry, engine: PricingEngine, mode: CostMode): PricedEntry => {
  if (mode === "display") return { ...entry, cost: entry.costUSD ?? 0, missingPricing: false };
  if (mode === "auto" && entry.costUSD !== undefined) return { ...entry, cost: entry.costUSD, missingPricing: false };
  const cost = calculateCost(entry, engine);
  const missingPricing = cost === undefined && totalTokens(entry) > 0 && Boolean(entry.model) && !entry.recordedZeroCost;
  return { ...entry, cost: cost ?? 0, missingPricing };
};

export const priceEntries = (entries: UsageEntry[], engine: PricingEngine, mode: CostMode): PricedEntry[] =>
  entries.map((entry) => priceEntry(entry, engine, mode));
