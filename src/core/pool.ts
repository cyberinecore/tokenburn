import { availableParallelism } from "node:os";
import { statSync } from "node:fs";
import { Worker } from "node:worker_threads";

export type ParseJob = { parser: string; files: string[]; options?: Record<string, unknown> };

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

const splitBySize = (files: string[], parts: number): string[][] => {
  const sized = files.map((file, index) => ({ file, index, size: sizeOf(file) })).sort((a, b) => b.size - a.size);
  const buckets = Array.from({ length: parts }, () => ({ bytes: 0, items: [] as { file: string; index: number }[] }));
  for (const item of sized) {
    const target = buckets.reduce((min, b) => (b.bytes < min.bytes ? b : min), buckets[0]!);
    target.bytes += item.size;
    target.items.push(item);
  }
  return buckets.filter((b) => b.items.length).map((b) => b.items.sort((x, y) => x.index - y.index).map((i) => i.file));
};

export async function parseFilesParallel<T>(
  job: ParseJob,
  inline: (files: string[], options?: Record<string, unknown>) => T[][] | Promise<T[][]>,
): Promise<T[][]> {
  const totalBytes = job.files.reduce((acc, f) => acc + sizeOf(f), 0);
  const threads = threadCount();
  if (threads <= 1 || totalBytes < PARALLEL_MIN_BYTES || process.env.TOKENBURN_NO_WORKERS) return inline(job.files, job.options);
  const chunks = splitBySize(job.files, threads);
  const results = await Promise.all(
    chunks.map(
      (files) =>
        new Promise<{ files: string[]; perFile: T[][] }>((resolve, reject) => {
          const worker = new Worker(workerPath(), { workerData: { ...job, files } });
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
