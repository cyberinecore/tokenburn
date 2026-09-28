import type { Adapter } from "../core/types.ts";
import { claude } from "./claude.ts";
import { commandcode } from "./commandcode.ts";
import { codex } from "./codex.ts";
import { gemini } from "./gemini.ts";
import { muse } from "./muse.ts";
import { opencode } from "./opencode.ts";
import { qwen } from "./qwen.ts";

export const ADAPTERS: Adapter[] = [claude, codex, opencode, gemini, qwen, muse, commandcode];

export const findAdapter = (id: string): Adapter | undefined => ADAPTERS.find((adapter) => adapter.id === id);

export const adapterLabels = (): Map<string, string> => new Map(ADAPTERS.map((adapter) => [adapter.id, adapter.label]));
