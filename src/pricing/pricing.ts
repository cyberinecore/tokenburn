import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "../core/fs.ts";
import { resolveModelAlias } from "./aliases.ts";
import { BUILTIN_GLM, BUILTIN_OVERWRITE, BUILTIN_PRICING, type BuiltinRates } from "./builtin.ts";
import fastOverrides from "./data/fast-multiplier-overrides.json" with { type: "json" };
import litellmSnapshot from "./data/litellm.json" with { type: "json" };
import modelsDevSnapshot from "./data/models-dev.json" with { type: "json" };

export type Pricing = {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  cacheReadExplicit: boolean;
  cacheCreateExplicit: boolean;
  inputAbove200k?: number;
  outputAbove200k?: number;
  cacheCreateAbove200k?: number;
  cacheReadAbove200k?: number;
  longContextThreshold?: number;
  fastMultiplier: number;
};

export type PricingOverride = {
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cacheCreationInputTokenCost?: number;
  cacheReadInputTokenCost?: number;
  inputCostPerTokenAbove200kTokens?: number;
  outputCostPerTokenAbove200kTokens?: number;
  cacheCreationInputTokenCostAbove200kTokens?: number;
  cacheReadInputTokenCostAbove200kTokens?: number;
  fastMultiplier?: number;
};

type CompactLiteLlm = { i: number; o: number; cc?: number; cr?: number; ia?: number; oa?: number; cca?: number; cra?: number; ctx?: number; fast?: number };

type ModelsDevTier = { input?: number; output?: number; cache_read?: number; cache_write?: number; tier?: { type?: string; size?: number } };
type ModelsDevEntry = {
  cost: { input: number; output: number; cache_read?: number; cache_write?: number; tiers?: ModelsDevTier[] };
  exactOnly?: boolean;
  limit?: { context?: number };
};

const BUILTIN_CONTEXT_LIMITS: Record<string, number> = { "gpt-5.5": 1_050_000, "grok-4.3": 1_000_000, "gpt-5.4": 1_050_000 };

export const DEFAULT_LONG_CONTEXT_THRESHOLD = 200_000;
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const LIVE_CACHE_TTL_MS = 60 * 60 * 1000;

const PRICING_ALIASES: Record<string, string> = {
  "gpt-reserve": "gpt-5.6-luna",
  "gpt-5.6": "gpt-5.6-sol",
  "gpt-5.3-spark": "gpt-5.3-codex-spark",
};

export const normalizedPricingKey = (value: string): string => (/[.@]/.test(value) ? value.replace(/[.@]/g, "-") : value);

const isBoundary = (char: string | undefined): boolean => char === undefined || !/[A-Za-z0-9]/.test(char);

const suffixStartsWithNumericVersion = (key: string, suffix: string): boolean => {
  if (!/[0-9]$/.test(key)) return false;
  if (suffix[0] !== "-" && suffix[0] !== ".") return false;
  const digits = /^[0-9]+/.exec(suffix.slice(1))?.[0].length ?? 0;
  if (digits === 0) return false;
  const after = suffix[1 + digits];
  return !(digits === 8 && isBoundary(after));
};

const suffixAllowsMatch = (key: string, suffix: string): boolean => {
  if (suffix.length === 0) return true;
  if (!isBoundary(suffix[0])) return false;
  return !suffixStartsWithNumericVersion(key, suffix);
};

const containsPricingKey = (value: string, key: string): boolean => {
  if (!key) return false;
  let index = value.indexOf(key);
  while (index >= 0) {
    if (isBoundary(value[index - 1]) && suffixAllowsMatch(key, value.slice(index + key.length))) return true;
    index = value.indexOf(key, index + 1);
  }
  return false;
};

const pricingKeyMatches = (candidate: string, model: string, normalizedModel: string): boolean => {
  if (containsPricingKey(model, candidate) || containsPricingKey(candidate, model)) return true;
  const normalizedCandidate = normalizedPricingKey(candidate);
  return containsPricingKey(normalizedModel, normalizedCandidate) || containsPricingKey(normalizedCandidate, normalizedModel);
};

export const modelWithoutDateSuffix = (model: string): string => {
  if (model.length > 11 && /-\d{4}-\d{2}-\d{2}$/.test(model)) return model.slice(0, -11);
  if (model.length > 9 && /-\d{8}$/.test(model)) return model.slice(0, -9);
  return model;
};

const matchesModelSuffix = (part: string, base: string): boolean => {
  const index = part.lastIndexOf(base);
  if (index < 0) return false;
  const suffix = part.slice(index);
  return suffix === base || suffix[base.length] === "-";
};

const fastMultiplierFor = (model: string): number | undefined => {
  const exact = fastOverrides.exact as Record<string, number>;
  const prefix = fastOverrides.normalized_prefix as Record<string, number>;
  if (exact[model] !== undefined) return exact[model];
  const alias = PRICING_ALIASES[model];
  if (alias && exact[alias] !== undefined) return exact[alias];
  for (const part of model.split(/[/:]/)) {
    if (exact[part] !== undefined) return exact[part];
    const partAlias = PRICING_ALIASES[part];
    if (partAlias && exact[partAlias] !== undefined) return exact[partAlias];
    const normalized = part.replace(/[.@]/g, "-");
    for (const [base, multiplier] of Object.entries(prefix)) if (matchesModelSuffix(normalized, base)) return multiplier;
  }
  return undefined;
};

const fromBuiltin = (model: string, rates: BuiltinRates): Pricing => ({
  input: rates.input,
  output: rates.output,
  cacheCreate: rates.cacheCreate,
  cacheRead: rates.cacheRead,
  cacheReadExplicit: true,
  cacheCreateExplicit: true,
  inputAbove200k: rates.inputAbove200k,
  outputAbove200k: rates.outputAbove200k,
  cacheCreateAbove200k: rates.cacheCreateAbove200k,
  cacheReadAbove200k: rates.cacheReadAbove200k,
  fastMultiplier: rates.fastFromOverrides ? (fastMultiplierFor(model) ?? 1) : 1,
});

const fromLiteLlm = (model: string, raw: CompactLiteLlm): Pricing => ({
  input: raw.i,
  output: raw.o,
  cacheCreate: raw.cc ?? raw.i * 1.25,
  cacheRead: raw.cr ?? raw.i * 0.1,
  cacheReadExplicit: raw.cr !== undefined,
  cacheCreateExplicit: raw.cc !== undefined,
  inputAbove200k: raw.ia,
  outputAbove200k: raw.oa,
  cacheCreateAbove200k: raw.cca,
  cacheReadAbove200k: raw.cra,
  fastMultiplier: raw.fast ?? fastMultiplierFor(model) ?? 1,
});

const longContextTier = (tiers: ModelsDevTier[] | undefined) => {
  let best: { threshold: number; tier: ModelsDevTier } | undefined;
  for (const tier of tiers ?? []) {
    if (tier.tier?.type !== "context" || !tier.tier.size || tier.tier.size <= 0) continue;
    if (!best || tier.tier.size < best.threshold) best = { threshold: tier.tier.size, tier };
  }
  return best;
};

const perToken = (value: number | undefined) => (value === undefined ? undefined : value / 1_000_000);

const fromModelsDev = (model: string, entry: ModelsDevEntry): Pricing => {
  const input = entry.cost.input / 1_000_000;
  const tier = longContextTier(entry.cost.tiers);
  return {
    input,
    output: entry.cost.output / 1_000_000,
    cacheCreate: perToken(entry.cost.cache_write) ?? input * 1.25,
    cacheRead: perToken(entry.cost.cache_read) ?? input * 0.1,
    cacheReadExplicit: entry.cost.cache_read !== undefined,
    cacheCreateExplicit: entry.cost.cache_write !== undefined,
    inputAbove200k: perToken(tier?.tier.input),
    outputAbove200k: perToken(tier?.tier.output),
    cacheCreateAbove200k: perToken(tier?.tier.cache_write),
    cacheReadAbove200k: perToken(tier?.tier.cache_read),
    longContextThreshold: tier?.threshold,
    fastMultiplier: fastMultiplierFor(model) ?? 1,
  };
};

class ExactOnlyKeys {
  private ids = new Set<string>();
  private spellings = new Map<string, string>();

  add(id: string): void {
    this.ids.add(id);
    this.spellings.set(normalizedPricingKey(id), id);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  hasAnySpelling(model: string): boolean {
    return this.ids.has(model) || this.spellings.has(normalizedPricingKey(model));
  }

  idSpelledBy(model: string): string | undefined {
    return this.ids.has(model) ? model : this.spellings.get(normalizedPricingKey(model));
  }
}

class PricingTable {
  entries = new Map<string, Pricing>();
  exactOnly = new ExactOnlyKeys();
  private sortedKeys?: string[];

  set(model: string, pricing: Pricing): void {
    this.entries.set(model, pricing);
    this.sortedKeys = undefined;
  }

  keys(): string[] {
    this.sortedKeys ??= [...this.entries.keys()];
    return this.sortedKeys;
  }

  findEntry(model: string, fuzzy: boolean, fallback?: PricingTable): Pricing | undefined {
    const direct = this.entries.get(model);
    if (direct) return direct;
    const exactId = this.exactOnly.idSpelledBy(model);
    if (exactId) return this.entries.get(exactId);
    if (!fuzzy || this.exactOnly.hasAnySpelling(model) || fallback?.exactOnly.hasAnySpelling(model)) return undefined;
    const normalizedModel = normalizedPricingKey(model);
    let best: string | undefined;
    for (const candidate of this.keys()) {
      if (this.exactOnly.has(candidate)) continue;
      if (!pricingKeyMatches(candidate, model, normalizedModel)) continue;
      if (!best || candidate.length > best.length || (candidate.length === best.length && candidate < best)) best = candidate;
    }
    return best ? this.entries.get(best) : undefined;
  }

  findEntryOrAlias(model: string, fuzzy: boolean, fallback?: PricingTable): Pricing | undefined {
    const direct = this.entries.get(model);
    if (direct) return direct;
    const alias = PRICING_ALIASES[model];
    if (alias) {
      const viaAlias = this.findEntry(alias, fuzzy, fallback);
      if (viaAlias) return viaAlias;
    }
    return this.findEntry(model, fuzzy, fallback);
  }
}

const DEEPSEEK_V4_CUTOFF_MS = 1_786_896_000_000;
type Rates = [number, number, number, number];
const DEEPSEEK_V4: Record<string, [Rates, Rates, Rates]> = {
  "deepseek-v4-flash": [
    [0.14e-6, 0.28e-6, 0.14e-6, 0.0028e-6],
    [0.22e-6, 0.66e-6, 0.22e-6, 0.007e-6],
    [0.44e-6, 1.32e-6, 0.44e-6, 0.014e-6],
  ],
  "deepseek-v4-pro": [
    [0.435e-6, 0.87e-6, 0.435e-6, 0.003625e-6],
    [0.66e-6, 1.98e-6, 0.66e-6, 0.022e-6],
    [1.32e-6, 3.96e-6, 1.32e-6, 0.044e-6],
  ],
};

const deepseekIdentity = (model: string): string | undefined => {
  const normalized = normalizedPricingKey(model);
  return normalized in DEEPSEEK_V4 ? normalized : undefined;
};

const deepseekPeak = (timestamp: number): boolean => {
  const day = Math.floor(timestamp / 86_400_000);
  const weekday = (((day + 4) % 7) + 7) % 7;
  if (weekday < 1 || weekday > 5) return false;
  const hour = Math.floor((((timestamp % 86_400_000) + 86_400_000) % 86_400_000) / 3_600_000);
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
};

const applyOverride = (pricing: Pricing, o: PricingOverride): Pricing => ({
  ...pricing,
  input: o.inputCostPerToken ?? pricing.input,
  output: o.outputCostPerToken ?? pricing.output,
  cacheCreate: o.cacheCreationInputTokenCost ?? pricing.cacheCreate,
  cacheRead: o.cacheReadInputTokenCost ?? pricing.cacheRead,
  cacheCreateExplicit: pricing.cacheCreateExplicit || o.cacheCreationInputTokenCost !== undefined,
  cacheReadExplicit: pricing.cacheReadExplicit || o.cacheReadInputTokenCost !== undefined,
  inputAbove200k: o.inputCostPerTokenAbove200kTokens ?? pricing.inputAbove200k,
  outputAbove200k: o.outputCostPerTokenAbove200kTokens ?? pricing.outputAbove200k,
  cacheCreateAbove200k: o.cacheCreationInputTokenCostAbove200kTokens ?? pricing.cacheCreateAbove200k,
  cacheReadAbove200k: o.cacheReadInputTokenCostAbove200kTokens ?? pricing.cacheReadAbove200k,
  fastMultiplier: o.fastMultiplier ?? pricing.fastMultiplier,
});

const overrideToPricing = (o: PricingOverride): Pricing | undefined => {
  if (o.inputCostPerToken === undefined || o.outputCostPerToken === undefined) return undefined;
  return applyOverride(
    {
      input: o.inputCostPerToken,
      output: o.outputCostPerToken,
      cacheCreate: o.inputCostPerToken * 1.25,
      cacheRead: o.inputCostPerToken * 0.1,
      cacheReadExplicit: false,
      cacheCreateExplicit: false,
      fastMultiplier: 1,
    },
    o,
  );
};

const liveCachePath = () => join(process.env.XDG_CACHE_HOME || join(home(), ".cache"), "tokenburn", "litellm.json");

const readLiveCache = (path: string, maxAgeMs: number): Record<string, CompactLiteLlm> | undefined => {
  try {
    if (Date.now() - statSync(path).mtimeMs >= maxAgeMs) return undefined;
    const cached = JSON.parse(readFileSync(path, "utf8"));
    return cached && typeof cached === "object" && Object.keys(cached).length > 0 ? cached : undefined;
  } catch {
    return undefined;
  }
};

const loadLiveLiteLlm = async (warn: (m: string) => void): Promise<Record<string, CompactLiteLlm> | undefined> => {
  const path = liveCachePath();
  const fresh = readLiveCache(path, LIVE_CACHE_TTL_MS);
  if (fresh) return fresh;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(LITELLM_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { compactLiteLlm } = await import("../../scripts/build-pricing-data.ts");
    const compact = compactLiteLlm((await response.json()) as Record<string, Record<string, unknown>>, false);
    if (Object.keys(compact).length === 0) throw new Error("no usable entries");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(compact));
    return compact as Record<string, CompactLiteLlm>;
  } catch (error) {
    const reason = (error as Error).message;
    const stale = readLiveCache(path, Number.POSITIVE_INFINITY);
    if (stale) {
      const fetchedAt = new Date(statSync(path).mtimeMs).toISOString().slice(0, 16).replace("T", " ");
      warn(`WARN  Failed to fetch LiteLLM pricing (${reason}); using cached pricing from ${fetchedAt} UTC.`);
      return stale;
    }
    warn(`WARN  Failed to fetch LiteLLM pricing (${reason}); using embedded pricing.`);
    return undefined;
  }
};

export class PricingEngine {
  private primary = new PricingTable();
  private modelsDev = new PricingTable();
  private overrides = new Map<string, PricingOverride>();
  private contextLimits = new Map<string, number>();
  private modelsDevContext = new Map<string, number>();
  private cache = new Map<string, Pricing | undefined>();

  static async load(options: {
    offline: boolean;
    overrides?: Record<string, PricingOverride>;
    warn: (m: string) => void;
  }): Promise<PricingEngine> {
    const engine = new PricingEngine();
    for (const [model, entry] of Object.entries(modelsDevSnapshot as Record<string, ModelsDevEntry>)) {
      if (entry.cost.input === 0 && entry.cost.output === 0) continue;
      engine.modelsDev.set(model, fromModelsDev(model, entry));
      if (entry.exactOnly) engine.modelsDev.exactOnly.add(model);
      if (entry.limit?.context) engine.modelsDevContext.set(model, entry.limit.context);
    }
    engine.loadLiteLlm(litellmSnapshot as Record<string, CompactLiteLlm>);
    engine.putBuiltins();
    if (!options.offline) {
      const live = await loadLiveLiteLlm(options.warn);
      if (live) engine.loadLiteLlm(live);
    }
    engine.fillLongContextRates();
    for (const [model, override] of Object.entries(options.overrides ?? {})) {
      engine.overrides.set(model, override);
      const existing = engine.primary.entries.get(model);
      const next = existing ? applyOverride(existing, override) : overrideToPricing(override);
      if (next) engine.primary.set(model, next);
    }
    return engine;
  }

  private loadLiteLlm(raw: Record<string, CompactLiteLlm>): void {
    for (const [model, value] of Object.entries(raw)) {
      this.primary.set(model, fromLiteLlm(model, value));
      if (value.ctx) this.contextLimits.set(model, value.ctx);
    }
  }

  contextLimit(model: string): number | undefined {
    const resolved = resolveModelAlias(model);
    for (const candidate of [model, resolved]) {
      const direct = this.contextLimits.get(candidate) ?? BUILTIN_CONTEXT_LIMITS[candidate] ?? this.modelsDevContext.get(candidate);
      if (direct) return direct;
    }
    const normalized = normalizedPricingKey(resolved);
    for (const map of [this.contextLimits, new Map(Object.entries(BUILTIN_CONTEXT_LIMITS)), this.modelsDevContext]) {
      let best: string | undefined;
      for (const key of map.keys()) {
        if (!pricingKeyMatches(key, resolved, normalized)) continue;
        if (!best || key.length > best.length) best = key;
      }
      if (best) return map.get(best);
    }
    return undefined;
  }

  private putBuiltins(): void {
    for (const [model, rates] of Object.entries(BUILTIN_PRICING)) {
      if (!this.primary.entries.has(model)) this.primary.set(model, fromBuiltin(model, rates));
    }
    for (const [model, rates] of Object.entries(BUILTIN_OVERWRITE)) this.primary.set(model, fromBuiltin(model, rates));
    for (const [model, rates] of Object.entries(BUILTIN_GLM)) {
      const existing = this.primary.entries.get(model);
      if (!existing) {
        this.primary.set(model, fromBuiltin(model, rates));
        continue;
      }
      this.primary.set(model, {
        ...existing,
        cacheRead: existing.cacheReadExplicit ? existing.cacheRead : rates.cacheRead,
        cacheCreate: existing.cacheCreateExplicit ? existing.cacheCreate : rates.cacheCreate,
        cacheReadExplicit: true,
        cacheCreateExplicit: true,
      });
    }
  }

  private fillLongContextRates(): void {
    for (const [model, pricing] of this.primary.entries) {
      if (
        pricing.inputAbove200k !== undefined ||
        pricing.outputAbove200k !== undefined ||
        pricing.cacheCreateAbove200k !== undefined ||
        pricing.cacheReadAbove200k !== undefined
      )
        continue;
      const base = modelWithoutDateSuffix(model);
      const resolved = PRICING_ALIASES[base] ?? base;
      const source = this.modelsDev.entries.get(resolved) ?? this.modelsDev.entries.get(base);
      if (!source?.longContextThreshold) continue;
      this.primary.entries.set(model, {
        ...pricing,
        inputAbove200k: source.inputAbove200k,
        outputAbove200k: source.outputAbove200k,
        cacheCreateAbove200k: source.cacheCreateAbove200k,
        cacheReadAbove200k: source.cacheReadAbove200k,
        longContextThreshold: source.longContextThreshold,
      });
    }
  }

  private requiresExact(model: string): boolean {
    const check = (m: string) => this.primary.exactOnly.hasAnySpelling(m) || this.modelsDev.exactOnly.hasAnySpelling(m);
    const alias = PRICING_ALIASES[model];
    return check(model) || (alias !== undefined && check(alias));
  }

  find(model: string): Pricing | undefined {
    if (this.cache.has(model)) return this.cache.get(model);
    const resolved = resolveModelAlias(model);
    let result =
      this.primary.findEntryOrAlias(model, false) ??
      (resolved !== model ? this.primary.findEntryOrAlias(resolved, false) : undefined);
    if (!result) {
      const fuzzy = !(this.requiresExact(model) || (resolved !== model && this.requiresExact(resolved)));
      result =
        this.primary.findEntryOrAlias(model, fuzzy, this.modelsDev) ??
        (resolved !== model ? this.primary.findEntryOrAlias(resolved, fuzzy, this.modelsDev) : undefined) ??
        this.modelsDev.findEntryOrAlias(resolved, fuzzy);
    }
    this.cache.set(model, result);
    return result;
  }

  hasOverride(model: string): boolean {
    return this.overrides.has(model);
  }

  findExact(model: string): Pricing | undefined {
    return this.primary.findEntry(model, false) ?? this.modelsDev.findEntry(model, false);
  }

  longContextSplitThreshold(model: string): number {
    const base = modelWithoutDateSuffix(model);
    const resolved = PRICING_ALIASES[base] ?? base;
    const entry = this.modelsDev.entries.get(resolved) ?? this.modelsDev.entries.get(base);
    return entry?.longContextThreshold ?? DEFAULT_LONG_CONTEXT_THRESHOLD;
  }

  findAt(model: string, timestamp: number | undefined): Pricing | undefined {
    const resolved = resolveModelAlias(model);
    const scheduled = deepseekIdentity(model) ?? deepseekIdentity(resolved);
    const base = this.find(model);
    if (!scheduled || !base || timestamp === undefined) return base;
    const [old, offPeak, peak] = DEEPSEEK_V4[scheduled]!;
    const [input, output, cacheCreate, cacheRead] = timestamp < DEEPSEEK_V4_CUTOFF_MS ? old : deepseekPeak(timestamp) ? peak : offPeak;
    let pricing: Pricing = {
      ...base,
      input,
      output,
      cacheCreate,
      cacheRead,
      inputAbove200k: input,
      outputAbove200k: output,
      cacheCreateAbove200k: cacheCreate,
      cacheReadAbove200k: cacheRead,
      cacheCreateExplicit: true,
      cacheReadExplicit: true,
    };
    const override = this.overrides.get(model) ?? this.overrides.get(resolved) ?? this.overrides.get(scheduled);
    if (override) pricing = applyOverride(pricing, override);
    return pricing;
  }
}

export type CostTokens = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cacheCreation1hTokens?: number;
};

const tieredCost = (tokens: number, base: number, above: number | undefined, threshold: number): number => {
  if (tokens === 0) return 0;
  if (above !== undefined && tokens > threshold) return threshold * base + (tokens - threshold) * above;
  return tokens * base;
};

export const costFromPricing = (usage: CostTokens, pricing: Pricing): number => {
  const oneHour = usage.cacheCreation1hTokens ?? 0;
  const fiveMinute = usage.cacheCreationTokens - oneHour;
  const oneHourRate = pricing.input * 2;
  const oneHourAbove = pricing.inputAbove200k === undefined ? undefined : pricing.inputAbove200k * 2;
  if (pricing.longContextThreshold !== undefined) {
    const context = usage.inputTokens + usage.cacheReadTokens + fiveMinute + oneHour;
    const long = context > pricing.longContextThreshold;
    const rate = (base: number, above: number | undefined) => (long ? (above ?? base) : base);
    return (
      usage.inputTokens * rate(pricing.input, pricing.inputAbove200k) +
      usage.outputTokens * rate(pricing.output, pricing.outputAbove200k) +
      fiveMinute * rate(pricing.cacheCreate, pricing.cacheCreateAbove200k) +
      oneHour * rate(oneHourRate, oneHourAbove) +
      usage.cacheReadTokens * rate(pricing.cacheRead, pricing.cacheReadAbove200k)
    );
  }
  const t = DEFAULT_LONG_CONTEXT_THRESHOLD;
  return (
    tieredCost(usage.inputTokens, pricing.input, pricing.inputAbove200k, t) +
    tieredCost(usage.outputTokens, pricing.output, pricing.outputAbove200k, t) +
    tieredCost(fiveMinute, pricing.cacheCreate, pricing.cacheCreateAbove200k, t) +
    tieredCost(oneHour, oneHourRate, oneHourAbove, t) +
    tieredCost(usage.cacheReadTokens, pricing.cacheRead, pricing.cacheReadAbove200k, t)
  );
};
