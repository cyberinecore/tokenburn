import { parentPort, workerData } from "node:worker_threads";
import { findAdapter } from "../adapters/registry.ts";
import { cacheRaw, pack } from "../core/cache.ts";

const { parser, options } = workerData as { parser: string; options?: Record<string, unknown> };
const adapter = findAdapter(parser);
if (!adapter?.parseFiles) throw new Error(`adapter ${parser} has no parseFiles`);
parentPort!.on("message", async ({ files, cache }: { files: string[]; cache: boolean }) => {
  const perFile = await adapter.parseFiles!(files, options);
  parentPort!.postMessage(perFile.map((rows) => [pack(rows), cache ? cacheRaw(rows) : undefined]));
});
