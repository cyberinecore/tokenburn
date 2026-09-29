import type { Adapter } from "../core/types.ts";
import { amp } from "./amp.ts";
import { droid } from "./droid.ts";
import { codebuff } from "./codebuff.ts";
import { hermes } from "./hermes.ts";
import { pi } from "./pi.ts";
import { goose } from "./goose.ts";
import { kilo } from "./kilo.ts";
import { copilot } from "./copilot.ts";
import { antigravity } from "./antigravity.ts";
import { kimi } from "./kimi.ts";
import { openclaw } from "./openclaw.ts";
import { grok } from "./grok.ts";
import { zcode } from "./zcode.ts";
import { cline } from "./cline.ts";
import { continueAdapter } from "./continue.ts";
import { claude } from "./claude.ts";
import { commandcode } from "./commandcode.ts";
import { codex } from "./codex.ts";
import { gemini } from "./gemini.ts";
import { muse } from "./muse.ts";
import { opencode } from "./opencode.ts";
import { qwen } from "./qwen.ts";

export const ADAPTERS: Adapter[] = [claude, codex, opencode, gemini, qwen, muse, commandcode, amp, droid, codebuff, hermes, pi, goose, kilo, copilot, antigravity, kimi, openclaw, grok, zcode, cline, continueAdapter];

export const findAdapter = (id: string): Adapter | undefined => ADAPTERS.find((adapter) => adapter.id === id);

export const adapterLabels = (): Map<string, string> => new Map(ADAPTERS.map((adapter) => [adapter.id, adapter.label]));
