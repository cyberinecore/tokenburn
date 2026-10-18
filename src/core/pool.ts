import { availableParallelism } from "node:os";
import { statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { openParseCache, type Packed, unpack } from "./cache.ts";

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

type Reply = [Packed, string | undefined][];

type Task = {
  job: number;
  parser: string;
  options?: Record<string, unknown>;
  files: string[];
  cache: boolean;
  done: (reply: Reply) => void;
  fail: (error: unknown) => void;
};

const queue: Task[] = [];
const idle: Worker[] = [];
const jobsSeen = new WeakMap<Worker, Set<number>>();
let spawned = 0;
let jobs = 0;

// DECISION: every parser shares one process-wide worker pool capped at threadCount(), not a pool per adapter call, because concurrent adapters each spawning their own workers oversubscribed the cores and stretched the Claude parse from about 3s to 6s.
const spawn = (): Worker => {
  const worker = new Worker(workerPath());
  worker.on("error", () => {});
  worker.unref();
  jobsSeen.set(worker, new Set());
  spawned++;
  return worker;
};

const run = (worker: Worker, task: Task): void => {
  const seen = jobsSeen.get(worker)!;
  const withOptions = !seen.has(task.job);
  seen.add(task.job);
  worker.ref();
  const onError = (error: unknown) => {
    worker.off("message", onMessage);
    spawned--;
    void worker.terminate();
    task.fail(error);
    pump();
  };
  const onMessage = (reply: Reply) => {
    worker.off("error", onError);
    worker.unref();
    idle.push(worker);
    pump();
    task.done(reply);
  };
  worker.once("message", onMessage);
  worker.once("error", onError);
  worker.postMessage({ job: task.job, parser: task.parser, withOptions, options: withOptions ? task.options : undefined, files: task.files, cache: task.cache });
};

const pump = (): void => {
  while (queue.length) {
    let worker = idle.pop();
    if (!worker) {
      if (spawned >= threadCount()) return;
      worker = spawn();
    }
    run(worker, queue.shift()!);
  }
};

export const prewarmWorkers = (): void => {
  if (process.env.TOKENBURN_NO_WORKERS) return;
  const threads = threadCount();
  if (threads <= 1) return;
  while (spawned < threads) idle.push(spawn());
};

type Inline<T> = (files: string[], options?: Record<string, unknown>) => T[][] | Promise<T[][]>;

export type Emit<T> = (index: number, value: T[]) => void;

type Deliver<T> = (index: number, value: T[], raw?: string) => void;

const BATCH_BYTES = 16 * 1024 * 1024;
const BATCH_FILES = 64;

export async function parseFilesParallel<T>(job: ParseJob, inline: Inline<T>, emit?: Emit<T>): Promise<T[][]> {
  const result: (T[] | undefined)[] = new Array(job.files.length);
  let next = 0;
  const settle = (index: number, value: T[]) => {
    result[index] = value;
    while (next < result.length && result[next] !== undefined) {
      emit?.(next, result[next]!);
      next++;
    }
  };
  const cache = job.cacheKey ? openParseCache<T>(job.parser) : undefined;
  const stamps: (string | undefined)[] = [];
  const missing: number[] = [];
  const hits: [number, T[]][] = [];
  job.files.forEach((file, i) => {
    if (!cache) {
      missing.push(i);
      return;
    }
    const { hit, stamp } = cache.lookup(file, job.cacheKey!(file));
    stamps[i] = stamp;
    if (hit) hits.push([i, hit]);
    else missing.push(i);
  });
  for (const [i, hit] of hits) settle(i, hit);
  if (missing.length) {
    await parseUncached(
      { ...job, files: missing.map((i) => job.files[i]!), bytes: job.bytes && missing.map((i) => job.bytes![i]!) },
      inline,
      (k, value, raw) => {
        const i = missing[k]!;
        if (raw !== undefined) cache?.storeRaw(job.files[i]!, stamps[i], raw);
        else cache?.store(job.files[i]!, stamps[i], value);
        settle(i, value);
      },
      cache !== undefined,
    );
    cache?.save();
  }
  return result.map((value) => value ?? []);
}

async function parseUncached<T>(job: ParseJob, inline: Inline<T>, deliver: Deliver<T>, cache = false): Promise<void> {
  const sizes = job.bytes ?? job.files.map(sizeOf);
  const totalBytes = sizes.reduce((acc, size) => acc + size, 0);
  const threads = threadCount();
  if (threads <= 1 || (totalBytes < PARALLEL_MIN_BYTES && !job.force) || process.env.TOKENBURN_NO_WORKERS) {
    (await inline(job.files, job.options)).forEach((value, k) => deliver(k, value ?? []));
    return;
  }
  const batches: number[][] = [];
  let current: number[] = [];
  let bytes = 0;
  job.files.forEach((_, k) => {
    current.push(k);
    bytes += sizes[k]!;
    if (bytes >= BATCH_BYTES || current.length >= BATCH_FILES) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
  });
  if (current.length) batches.push(current);
  const id = ++jobs;
  await Promise.all(
    batches.map(
      (batch) =>
        new Promise<void>((resolve, reject) => {
          queue.push({
            job: id,
            parser: job.parser,
            options: job.options,
            files: batch.map((k) => job.files[k]!),
            cache,
            done: (reply) => {
              batch.forEach((k, j) => {
                const item = reply[j];
                if (!item) deliver(k, []);
                else if (item[1] !== undefined) deliver(k, unpack(item[0]) as T[], item[1]);
                else deliver(k, unpack(item[0]) as T[]);
              });
              resolve();
            },
            fail: reject,
          });
          pump();
        }),
    ),
  );
}
