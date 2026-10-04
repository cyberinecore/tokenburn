import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PricingEngine } from "../src/pricing/pricing.ts";

const CACHED_ONLY_MODEL = "tokenburn-test-cached-only-model";
const originalFetch = globalThis.fetch;
const originalCacheHome = process.env.XDG_CACHE_HOME;
let cacheHome: string;

const writeCache = (ageMs: number) => {
  const dir = join(cacheHome, "tokenburn");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "litellm.json");
  writeFileSync(path, JSON.stringify({ [CACHED_ONLY_MODEL]: { i: 0.000003, o: 0.000015 } }));
  const mtime = new Date(Date.now() - ageMs);
  utimesSync(path, mtime, mtime);
};

beforeEach(() => {
  cacheHome = mkdtempSync(join(tmpdir(), "tokenburn-pricing-"));
  process.env.XDG_CACHE_HOME = cacheHome;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCacheHome;
  rmSync(cacheHome, { recursive: true, force: true });
});

test("failed fetch falls back to a stale live cache before embedded pricing", async () => {
  writeCache(3 * 24 * 60 * 60 * 1000);
  const warnings: string[] = [];
  const engine = await PricingEngine.load({ offline: false, warn: (m) => warnings.push(m) });
  expect(engine.find(CACHED_ONLY_MODEL)?.input).toBe(0.000003);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("using cached pricing from");
});

test("failed fetch without any cache uses embedded pricing", async () => {
  const warnings: string[] = [];
  const engine = await PricingEngine.load({ offline: false, warn: (m) => warnings.push(m) });
  expect(engine.find(CACHED_ONLY_MODEL)).toBeUndefined();
  expect(engine.find("claude-sonnet-5-5")).toBeDefined();
  expect(warnings[0]).toContain("using embedded pricing");
});

test("fresh live cache is used without fetching", async () => {
  writeCache(60 * 1000);
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("should not fetch");
  }) as unknown as typeof fetch;
  const warnings: string[] = [];
  const engine = await PricingEngine.load({ offline: false, warn: (m) => warnings.push(m) });
  expect(fetched).toBe(false);
  expect(warnings).toHaveLength(0);
  expect(engine.find(CACHED_ONLY_MODEL)?.input).toBe(0.000003);
});

test("offline mode never reads the live cache", async () => {
  writeCache(60 * 1000);
  const engine = await PricingEngine.load({ offline: true, warn: () => {} });
  expect(engine.find(CACHED_ONLY_MODEL)).toBeUndefined();
  expect(engine.find("gpt-6.1-sol")).toBeDefined();
});
