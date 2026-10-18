import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "./fs.ts";

const FORMAT = "tokenburn-parse-cache-1";

type Stamp = string;

type Slot = { stamp: Stamp; raw: string };

export type Lookup<T> = { hit?: T[]; stamp?: Stamp };

export type ParseCache<T> = {
  lookup(file: string, extra: string): Lookup<T>;
  store(file: string, stamp: Stamp | undefined, value: T[]): void;
  storeRaw(file: string, stamp: Stamp | undefined, raw: string | undefined): void;
  save(): void;
};

export const cacheDisabled = (): boolean => Boolean(process.env.TOKENBURN_NO_CACHE);

const cacheDir = (): string => {
  if (process.env.TOKENBURN_CACHE_DIR) return process.env.TOKENBURN_CACHE_DIR;
  const xdg = process.env.XDG_CACHE_HOME?.startsWith("/") ? process.env.XDG_CACHE_HOME : join(home(), ".cache");
  return join(xdg, "tokenburn");
};

declare const TOKENBURN_PARSER_HASHES: string | undefined;

// DECISION: the cache is keyed by a build-time hash of each parser's own import closure, not by the package version or the whole bundle, because an upgrade that leaves a parser untouched should keep its cache while any edit reachable from that parser must drop it.
const parserCodeHash = (parser: string): string | undefined => {
  if (typeof TOKENBURN_PARSER_HASHES !== "string") return undefined;
  return (JSON.parse(TOKENBURN_PARSER_HASHES) as Record<string, string>)[parser];
};

export const fileStamp = (file: string): string => {
  try {
    const s = statSync(file, { bigint: true });
    return `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`;
  } catch {
    return "-";
  }
};

const stampOf = (file: string, extra: string): Stamp | undefined => {
  const stamp = fileStamp(file);
  return stamp === "-" ? undefined : `${stamp}:${extra}`;
};

const jsonSafe = (value: unknown): boolean => {
  let safe = true;
  JSON.stringify(value, (_key, v) => {
    if (typeof v === "number" && !Number.isFinite(v)) safe = false;
    if (v === undefined || typeof v === "bigint" || typeof v === "function") safe = false;
    if (Array.isArray(v) && v.some((item) => item === undefined)) safe = false;
    return v;
  });
  return safe;
};

const stripUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) if (child !== undefined) out[key] = stripUndefined(child);
    return out;
  }
  return value;
};

type Row = Record<string, unknown>;

export type Packed = { v: unknown[] } | { k: string[]; c: Record<string, unknown>; r: unknown[][] };

const isRow = (value: unknown): value is Row =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

export const pack = (rows: unknown[]): Packed => {
  if (rows.length < 2 || !rows.every(isRow) || rows.some((row) => Object.keys(row).length > 30)) return { v: rows };
  const keys: string[] = [];
  const position = new Map<string, number>();
  for (const row of rows as Row[]) {
    let last = -1;
    for (const key of Object.keys(row)) {
      let at = position.get(key);
      if (at === undefined) {
        at = keys.length;
        keys.push(key);
        position.set(key, at);
      }
      if (at < last) return { v: rows };
      last = at;
    }
  }
  const constants: Record<string, unknown> = {};
  for (const key of keys) {
    const first = (rows[0] as Row)[key];
    if (first === null || typeof first === "object") continue;
    if ((rows as Row[]).every((row) => key in row && Object.is(row[key], first))) constants[key] = first;
  }
  const varying = keys.filter((key) => !(key in constants));
  const packed = (rows as Row[]).map((row) => {
    let mask = 0;
    const values: unknown[] = [0];
    varying.forEach((key, i) => {
      if (key in row) {
        mask |= 1 << i;
        values.push(row[key]);
      }
    });
    values[0] = mask;
    return values;
  });
  return { k: keys, c: constants, r: packed };
};

export const unpack = (packed: Packed): unknown[] => {
  if ("v" in packed) return packed.v;
  const varying = packed.k.filter((key) => !(key in packed.c));
  const slot = new Map(varying.map((key, i) => [key, i]));
  return packed.r.map((values) => {
    const mask = values[0] as number;
    const row: Row = {};
    let next = 1;
    for (const key of packed.k) {
      const i = slot.get(key);
      if (i === undefined) row[key] = packed.c[key];
      else if (mask & (1 << i)) row[key] = values[next++];
    }
    return row;
  });
};

const SHARDS = 32;

const shardOf = (file: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < file.length; i++) hash = Math.imul(hash ^ file.charCodeAt(i), 16777619);
  return (hash >>> 0) % SHARDS;
};

export const cacheRaw = (value: unknown[]): string | undefined => {
  const plain = stripUndefined(value) as unknown[];
  return jsonSafe(plain) ? JSON.stringify(pack(plain)) : undefined;
};

export const openParseCache = <T>(parser: string): ParseCache<T> | undefined => {
  if (cacheDisabled()) return undefined;
  const code = parserCodeHash(parser);
  if (!code) return undefined;
  const dir = cacheDir();
  const header = JSON.stringify({ format: FORMAT, parser, code });
  const shardPath = (shard: number) => join(dir, `${parser}-${String(shard).padStart(2, "0")}.jsonl`);
  const shards = Array.from({ length: SHARDS }, () => new Map<string, Slot>());
  const dirty = new Set<number>();
  for (let shard = 0; shard < SHARDS; shard++) {
    let text: string;
    try {
      text = readFileSync(shardPath(shard), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    if (lines[0] !== header) continue;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      const tab1 = line.indexOf("\t");
      const tab2 = tab1 < 0 ? -1 : line.indexOf("\t", tab1 + 1);
      if (tab2 < 0) continue;
      shards[shard]!.set(line.slice(0, tab1), { stamp: line.slice(tab1 + 1, tab2), raw: line.slice(tab2 + 1) });
    }
  }
  return {
    lookup(file, extra) {
      const stamp = stampOf(file, extra);
      const slot = shards[shardOf(file)]!.get(file);
      if (!stamp || !slot || stamp !== slot.stamp) return { stamp };
      try {
        return { hit: unpack(JSON.parse(slot.raw) as Packed) as T[], stamp };
      } catch {
        return { stamp };
      }
    },
    store(file, stamp, value) {
      this.storeRaw(file, stamp, stamp ? cacheRaw(value) : undefined);
    },
    storeRaw(file, stamp, raw) {
      if (!stamp || raw === undefined || file.includes("\t") || file.includes("\n")) return;
      const shard = shardOf(file);
      shards[shard]!.set(file, { stamp, raw });
      dirty.add(shard);
    },
    save() {
      if (dirty.size === 0) return;
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        return;
      }
      for (const shard of dirty) {
        const lines = [header];
        for (const [file, slot] of shards[shard]!) {
          try {
            statSync(file);
          } catch {
            continue;
          }
          lines.push(`${file}\t${slot.stamp}\t${slot.raw}`);
        }
        const path = shardPath(shard);
        const temp = `${path}.${process.pid}.tmp`;
        try {
          writeFileSync(temp, `${lines.join("\n")}\n`);
          renameSync(temp, path);
        } catch {}
      }
    },
  };
};
