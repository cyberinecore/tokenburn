import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageEntry } from "../src/core/types.ts";
import { calculateCost } from "../src/pricing/cost.ts";
import { isFreeTierModel, PricingEngine } from "../src/pricing/pricing.ts";

const M = 1e-6;
const LIVE = {
  "meta/tbtest-spark-1.3": { i: 1.25 * M, o: 4.25 * M, cr: 0.15 * M },
  "openrouter/meta/tbtest-spark-1.3": { i: 1.25 * M, o: 4.25 * M, cr: 0.15 * M },
  "openrouter/meta/tbtest-spark-1.3-contributor": { i: 0.1 * M, o: 0.2 * M, cr: 0.002 * M },
  "sail/acme-org/TBTEST-GLM-9": { i: 0.98 * M, o: 3.08 * M, cr: 0.18 * M },
  "acmeai/tbtest-glm-9": { i: 1.4 * M, o: 4.4 * M, cr: 0.26 * M },
  "together_ai/acme-org/TBTEST-GLM-9": { i: 1.4 * M, o: 4.4 * M, cr: 0.26 * M },
  "novita/acme-org/tbtest-glm-9": { i: 1.4 * M, o: 4.4 * M, cr: 0.26 * M },
  "moonshot/tbtest-kimi-7": { i: 0.6 * M, o: 3 * M, cr: 0.1 * M },
  "tbtest-kimi-7-turbo": { i: 9 * M, o: 9 * M, cr: 0.9 * M },
  "tbtest-paid-free": { i: 2 * M, o: 2 * M, cr: 0.2 * M },
};

const originalCacheHome = process.env.XDG_CACHE_HOME;
let cacheHome: string;
let engine: PricingEngine;

beforeAll(async () => {
  cacheHome = mkdtempSync(join(tmpdir(), "tokenburn-resolution-"));
  process.env.XDG_CACHE_HOME = cacheHome;
  mkdirSync(join(cacheHome, "tokenburn"), { recursive: true });
  writeFileSync(join(cacheHome, "tokenburn", "litellm.json"), JSON.stringify(LIVE));
  engine = await PricingEngine.load({ offline: false, warn: () => {} });
});

afterAll(() => {
  if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCacheHome;
  rmSync(cacheHome, { recursive: true, force: true });
});

const usage = (model: string, pricingCandidates?: string[]): UsageEntry => ({
  agent: "test",
  timestamp: Date.parse("2026-10-05T00:00:00Z"),
  sessionId: "s",
  projectPath: "p",
  model,
  pricingCandidates,
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  extraTotalTokens: 0,
});

test("bare model resolves to its provider-qualified price, not a longer variant", () => {
  expect(engine.find("tbtest-spark-1.3")?.input).toBeCloseTo(1.25 * M);
});

test("provider-qualified candidate wins over bare-name matches", () => {
  expect(calculateCost(usage("tbtest-spark-1.3", ["tbtest-spark-1.3", "meta/tbtest-spark-1.3"]), engine)).toBeCloseTo(1.25);
  expect(calculateCost(usage("tbtest-kimi-7", ["tbtest-kimi-7", "moonshot/tbtest-kimi-7"]), engine)).toBeCloseTo(0.6);
});

test("unqualified model takes the price most providers list, case-insensitively", () => {
  expect(engine.find("TBTEST-GLM-9")?.input).toBeCloseTo(1.4 * M);
});

test("free-tier models cost nothing unless an exact entry prices them", () => {
  expect(isFreeTierModel("opencode/tbtest-spark-1.3-contributor-free")).toBe(true);
  expect(isFreeTierModel("vendor/model:free")).toBe(true);
  expect(isFreeTierModel("freebird-1")).toBe(false);
  expect(calculateCost(usage("tbtest-spark-1.3-contributor-free"), engine)).toBe(0);
  expect(engine.find("tbtest-paid-free")?.input).toBeCloseTo(2 * M);
});
