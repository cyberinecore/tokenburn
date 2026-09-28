import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LITELLM_REV = process.env.LITELLM_REV ?? "22b36cbcf6583e2d6b552cc0e87ae6ab82c46341";
const MODELS_DEV_SOURCE = process.env.MODELS_DEV_SOURCE;
const outDir = join(dirname(new URL(import.meta.url).pathname), "..", "src", "pricing", "data");

const FIELDS: [string, string][] = [
  ["input_cost_per_token", "i"],
  ["output_cost_per_token", "o"],
  ["cache_creation_input_token_cost", "cc"],
  ["cache_read_input_token_cost", "cr"],
  ["input_cost_per_token_above_200k_tokens", "ia"],
  ["output_cost_per_token_above_200k_tokens", "oa"],
  ["cache_creation_input_token_cost_above_200k_tokens", "cca"],
  ["cache_read_input_token_cost_above_200k_tokens", "cra"],
  ["max_input_tokens", "ctx"],
];

const EMBEDDED_PREFIXES = [
  "claude-",
  "anthropic.",
  "anthropic/",
  "us.anthropic.",
  "eu.anthropic.",
  "global.anthropic.",
  "jp.anthropic.",
  "au.anthropic.",
  "gpt-",
  "openai/",
  "azure/",
  "zai/",
  "openrouter/openai/",
];

export const compactLiteLlm = (raw: Record<string, Record<string, unknown>>, filter: boolean) => {
  const out: Record<string, Record<string, number>> = {};
  for (const [model, pricing] of Object.entries(raw)) {
    if (filter && !EMBEDDED_PREFIXES.some((p) => model.startsWith(p))) continue;
    if (!pricing || typeof pricing !== "object") continue;
    const fields: Record<string, number> = {};
    for (const [source, target] of FIELDS) {
      const value = pricing[source];
      if (typeof value === "number") fields[target] = value;
    }
    const fast = (pricing.provider_specific_entry as { fast?: unknown } | undefined)?.fast;
    if (typeof fast === "number") fields.fast = fast;
    if ("i" in fields && "o" in fields) out[model] = fields;
  }
  return out;
};

const main = async () => {
  mkdirSync(outDir, { recursive: true });
  const url = `https://raw.githubusercontent.com/BerriAI/litellm/${LITELLM_REV}/model_prices_and_context_window.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`LiteLLM fetch failed: ${response.status}`);
  const litellm = compactLiteLlm((await response.json()) as Record<string, Record<string, unknown>>, true);
  writeFileSync(join(outDir, "litellm.json"), JSON.stringify(litellm));
  if (MODELS_DEV_SOURCE) {
    const modelsDev = JSON.parse(readFileSync(MODELS_DEV_SOURCE, "utf8"));
    writeFileSync(join(outDir, "models-dev.json"), JSON.stringify(modelsDev));
  }
  console.log(`litellm@${LITELLM_REV.slice(0, 7)}: ${Object.keys(litellm).length} models`);
};

if (import.meta.main) await main();
