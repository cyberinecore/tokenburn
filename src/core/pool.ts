import { availableParallelism } from "node:os";
import { statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { openParseCache } from "./cache.ts";

export type ParseJob = { parser: string; files: string[]; options?: Record<string, unknown>; bytes?: number[]; cacheKey?: (file: string) => string; force?: boolean };

const PARALLEL_MIN_BYTES = 64 * 1024 * 1024;

const workerPath = (): URL => {
  const self = import.meta.url;
  const relative = self.endsWith(".ts") ? "../workers/parse-worker.ts" : "./workers/parse-worker.js";
  return new URL(relative, self);
};

const threadCount = (): number => {
  const configured = Number(process.env.TOKENBURN_THREADS);
  if (Number.isInteger(configured) && configured > 0) return configured;
  return Math.max(1, Math.min(availableParallelism() - 1, 8));
};

const sizeOf = (file: string): number => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

const splitBySize = (files: string[], sizes: number[], parts: number): string[][] => {
  const sized = files.map((file, index) => ({ file, index, size: sizes[index]! })).sort((a, b) => b.size - a.size);
  const buckets = Array.from({ length: parts }, () => ({ bytes: 0, items: [] as { file: string; index: number }[] }));
  for (const item of sized) {
    const target = buckets.reduce((min, b) => (b.bytes < min.bytes ? b : min), buckets[0]!);
    target.bytes += item.size;
    target.items.push(item);
  }
  return buckets.filter((b) => b.items.length).map((b) => b.items.sort((x, y) => x.index - y.index).map((i) => i.file));
};

type Inline<T> = (files: string[], options?: Record<string, unknown>) => T[][] | Promise<T[][]>;

export async function parseFilesParallel<T>(job: ParseJob, inline: Inline<T>): Promise<T[][]> {
  const cache = job.cacheKey ? openParseCache<T>(job.parser) : undefined;
  if (!cache) return parseUncached(job, inline);
  const result: (T[] | undefined)[] = [];
  const stamps: (string | undefined)[] = [];
  const missing: number[] = [];
  job.files.forEach((file, i) => {
    const { hit, stamp } = cache.lookup(file, job.cacheKey!(file));
    result.push(hit);
    stamps.push(stamp);
    if (!hit) missing.push(i);
  });
  if (missing.length) {
    const parsed = await parseUncached(
      { ...job, files: missing.map((i) => job.files[i]!), bytes: job.bytes && missing.map((i) => job.bytes![i]!) },
      inline,
    );
    missing.forEach((i, k) => {
      const value = parsed[k] ?? [];
      result[i] = value;
      cache.store(job.files[i]!, stamps[i], value);
    });
    cache.save();
  }
  return result.map((value) => value ?? []);
}

async function parseUncached<T>(job: ParseJob, inline: Inline<T>): Promise<T[][]> {
  const sizes = job.bytes ?? job.files.map(sizeOf);
  const totalBytes = sizes.reduce((acc, size) => acc + size, 0);
  const threads = threadCount();
  if (threads <= 1 || (totalBytes < PARALLEL_MIN_BYTES && !job.force) || process.env.TOKENBURN_NO_WORKERS) return inline(job.files, job.options);
  const chunks = splitBySize(job.files, sizes, threads);
  const results = await Promise.all(
    chunks.map(
      (files) =>
        new Promise<{ files: string[]; perFile: T[][] }>((resolve, reject) => {
          const worker = new Worker(workerPath(), { workerData: { parser: job.parser, options: job.options, files } });
          worker.once("message", (perFile: T[][]) => {
            resolve({ files, perFile });
            void worker.terminate();
          });
          worker.once("error", reject);
        }),
    ),
  );
  const byFile = new Map<string, T[]>();
  for (const { files, perFile } of results) files.forEach((file, i) => byFile.set(file, perFile[i] ?? []));
  return job.files.map((file) => byFile.get(file) ?? []);
}
