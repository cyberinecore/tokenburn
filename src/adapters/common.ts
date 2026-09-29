import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { envPaths, home, isDir, walk } from "../core/fs.ts";
import { applyTotalTokenFallback } from "../core/tokens.ts";
import type { UsageEntry } from "../core/types.ts";

export type Obj = Record<string, any>;

export const envOrDefaultDirs = (env: string, defaults: (home: string) => string[]): string[] => {
  const candidates = process.env[env] !== undefined ? envPaths(env) : defaults(home());
  return [...new Set(candidates)].filter(isDir);
};

export const filesWithExtension = (dir: string, extension: string): string[] => [...walk(dir, (name) => extname(name) === `.${extension}`)];

export const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

export const readJson = (file: string): unknown => {
  const text = readText(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const jsonLines = (file: string): Obj[] => {
  const out: Obj[] = [];
  for (const line of (readText(file) ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) out.push(value);
    } catch {}
  }
  return out;
};

export const isObj = (value: unknown): value is Obj => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const u64 = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);

export const f64 = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

export const nonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const digits = (text: string): number | undefined => (/^\d+$/.test(text) ? Number(text) : undefined);

export const parseTsTimestamp = (value: string): number | undefined => {
  const len = value.length;
  let millis = 0;
  let tzStart: number;
  if ((len === 20 || len === 25) && "Z+-".includes(value[19]!)) tzStart = 19;
  else if ((len === 24 || len === 29) && value[19] === ".") {
    const ms = digits(value.slice(20, 23));
    if (ms === undefined) return undefined;
    millis = ms;
    tzStart = 23;
  } else return undefined;
  if (value[4] !== "-" || value[7] !== "-" || value[10] !== "T" || value[13] !== ":" || value[16] !== ":") return undefined;
  const parts = [value.slice(0, 4), value.slice(5, 7), value.slice(8, 10), value.slice(11, 13), value.slice(14, 16), value.slice(17, 19)].map(digits);
  if (parts.some((p) => p === undefined)) return undefined;
  const [year, month, day, hour, minute, second] = parts as number[];
  if (hour! > 23 || minute! > 59 || second! > 59) return undefined;
  const tz = value.slice(tzStart);
  let offset = 0;
  if (tz !== "Z") {
    if (tz.length !== 6 || !"+-".includes(tz[0]!) || tz[3] !== ":") return undefined;
    const h = digits(tz.slice(1, 3));
    const m = digits(tz.slice(4, 6));
    if (h === undefined || m === undefined || h > 23 || m > 59) return undefined;
    offset = (tz[0] === "+" ? 1 : -1) * (h * 60 + m);
  }
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) return undefined;
  return date.getTime() + ((hour! * 60 + minute!) * 60 + second!) * 1000 + millis - offset * 60_000;
};

export type RawTokens = { input: number; output: number; cacheCreation: number; cacheRead: number };

export type EntryFields = Omit<UsageEntry, "inputTokens" | "outputTokens" | "cacheCreationTokens" | "cacheReadTokens" | "extraTotalTokens">;

export const tokenEntry = (fields: EntryFields, tokens: RawTokens, total = 0, extra = 0): UsageEntry | undefined => {
  const { usage, extra: extraTotal } = applyTotalTokenFallback(tokens, extra, total);
  if (usage.input === 0 && usage.output === 0 && usage.cacheCreation === 0 && usage.cacheRead === 0 && extraTotal === 0) return undefined;
  return {
    ...fields,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheCreationTokens: usage.cacheCreation,
    cacheReadTokens: usage.cacheRead,
    extraTotalTokens: extraTotal,
  };
};

export const byTimestamp = (a: UsageEntry, b: UsageEntry) => a.timestamp - b.timestamp;

export const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export const sqlText = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : undefined;

export const sqlInt = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : undefined;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const match = /^\s*[-+]?\d+/.exec(value);
    return match ? Number(match[0]) : 0;
  }
  return undefined;
};
