import { parentPort } from "node:worker_threads";
import { findAdapter } from "../adapters/registry.ts";
import { cacheRaw, pack } from "../core/cache.ts";

type Task = { job: number; parser: string; withOptions: boolean; options?: Record<string, unknown>; files: string[]; cache: boolean };

const optionsByJob = new Map<number, Record<string, unknown> | undefined>();

parentPort!.on("message", async (task: Task) => {
  if (task.withOptions) optionsByJob.set(task.job, task.options);
  const adapter = findAdapter(task.parser);
  if (!adapter?.parseFiles) throw new Error(`adapter ${task.parser} has no parseFiles`);
  const perFile = await adapter.parseFiles(task.files, optionsByJob.get(task.job));
  parentPort!.postMessage(perFile.map((rows) => [pack(rows), task.cache ? cacheRaw(rows) : undefined]));
});
