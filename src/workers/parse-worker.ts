import { parentPort, workerData } from "node:worker_threads";
import { findAdapter } from "../adapters/registry.ts";

const { parser, files, options } = workerData as { parser: string; files: string[]; options?: Record<string, unknown> };
const adapter = findAdapter(parser);
if (!adapter?.parseFiles) throw new Error(`adapter ${parser} has no parseFiles`);
parentPort!.postMessage(await adapter.parseFiles(files, options));
