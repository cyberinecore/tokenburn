import { join } from "node:path";
import { expandHome, home } from "../core/fs.ts";
import { openReadonly } from "../core/sqlite.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { byTimestamp, isFile, jsonLines, nonEmpty, u64 } from "./common.ts";

const FREE_PROVIDERS = new Set(["free-trial", "ollama", "lmstudio", "llama.cpp", "llamafile"]);

const continueDir = (): string => {
  const env = process.env.CONTINUE_GLOBAL_DIR?.trim();
  return env ? expandHome(env) : join(home(), ".continue");
};

const sqlitePath = () => join(continueDir(), "dev_data", "devdata.sqlite");
const jsonlPath = () => join(continueDir(), "dev_data", "0.2.0", "tokensGenerated.jsonl");

const entry = (timestamp: number, model: string, provider: string, prompt: number, generated: number): UsageEntry | undefined => {
  if (prompt === 0 && generated === 0) return undefined;
  const free = FREE_PROVIDERS.has(provider);
  return {
    agent: "continue",
    timestamp,
    sessionId: new Date(timestamp).toISOString().slice(0, 10),
    projectPath: "Continue",
    model,
    inputTokens: prompt,
    outputTokens: generated,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    extraTotalTokens: 0,
    costUSD: free ? 0 : undefined,
    recordedZeroCost: free ? true : undefined,
    pricingCandidates: [...new Set([model, `${provider}/${model}`, model.replace(/-latest$/, ""), `${provider}/${model.replace(/-latest$/, "")}`])],
  };
};

const fromSqlite = async (): Promise<UsageEntry[] | undefined> => {
  if (!isFile(sqlitePath())) return undefined;
  const db = await openReadonly(sqlitePath());
  if (!db) return [];
  try {
    return db
      .all("SELECT model, provider, tokens_generated, tokens_prompt, timestamp FROM tokens_generated ORDER BY id")
      .map((row) => {
        const stamp = typeof row.timestamp === "string" ? Date.parse(`${row.timestamp.replace(" ", "T")}Z`) : NaN;
        if (!Number.isFinite(stamp)) return undefined;
        return entry(stamp, String(row.model ?? "unknown"), String(row.provider ?? ""), u64(row.tokens_prompt), u64(row.tokens_generated));
      })
      .filter((e): e is UsageEntry => Boolean(e));
  } finally {
    db.close();
  }
};

const fromJsonl = (): UsageEntry[] =>
  jsonLines(jsonlPath())
    .map((line) => {
      const text = nonEmpty(line.timestamp);
      const stamp = text ? Date.parse(text) : NaN;
      if (!Number.isFinite(stamp)) return undefined;
      return entry(stamp, nonEmpty(line.model) ?? "unknown", nonEmpty(line.provider) ?? "", u64(line.promptTokens), u64(line.generatedTokens));
    })
    .filter((e): e is UsageEntry => Boolean(e));

export const continueAdapter: Adapter = {
  id: "continue",
  label: "Continue",
  product: "Continue",
  envVars: ["CONTINUE_GLOBAL_DIR"],
  reports: ["daily", "weekly", "monthly", "session"],
  hasData: () => isFile(sqlitePath()) || isFile(jsonlPath()),
  async load(): Promise<UsageEntry[]> {
    return ((await fromSqlite()) ?? fromJsonl()).sort(byTimestamp);
  },
};
