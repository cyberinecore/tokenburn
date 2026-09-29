# Adding a provider

A provider (agent) is one TypeScript module that turns its local logs into `UsageEntry` records. Pricing, deduplication across reports, daily/weekly/monthly/session aggregation, tables and JSON are shared, so a new provider never touches them.

## 1. Write the adapter

Create `src/adapters/<id>.ts` and export an object that implements `Adapter` from `src/core/types.ts`:

```ts
import { join } from "node:path";
import { envPaths, home, isDir, walk } from "../core/fs.ts";
import type { Adapter, LoadContext, UsageEntry } from "../core/types.ts";

declare function parseAcmeFile(file: string, ctx: LoadContext): UsageEntry[];

const roots = (): string[] =>
  process.env.ACME_HOME !== undefined ? envPaths("ACME_HOME").filter(isDir) : [join(home(), ".acme")].filter(isDir);

export const acme: Adapter = {
  id: "acme",
  label: "Acme",
  product: "Acme CLI",
  envVars: ["ACME_HOME"],
  reports: ["daily", "weekly", "monthly", "session"],
  hasData: () => roots().length > 0,
  async load(ctx): Promise<UsageEntry[]> {
    const entries: UsageEntry[] = [];
    for (const root of roots()) {
      for (const file of walk(join(root, "sessions"), (name) => name.endsWith(".jsonl"))) entries.push(...parseAcmeFile(file, ctx));
    }
    return entries;
  },
};
```

`parseAcmeFile` stands for the provider-specific parser that returns one entry per model request. `id` is the CLI namespace (`tokenburn acme daily`) and the `agent` value in JSON. `label` is the short name in unified tables, `product` the name in titles and help.

## 2. Register it

Add one import and one array element to `src/adapters/registry.ts`. The order of `ADAPTERS` is the order agents load in and appear in `tokenburn agents`.

## 3. Map the log into `UsageEntry`

One entry per model request (or per turn if that is all the log keeps). Token fields follow the Claude convention, which the report layer and pricing assume:

| Field | Meaning |
|---|---|
| `inputTokens` | Fresh input only. If the log's input count includes cached tokens, subtract `cacheReadTokens` and `cacheCreationTokens`. |
| `cacheReadTokens` | Prompt tokens served from cache. |
| `cacheCreationTokens` | Tokens written to cache. Set `cacheCreation1hTokens` for the 1-hour part when the log splits it. |
| `outputTokens` | Output tokens, reasoning included when the provider bills it as output. |
| `extraTotalTokens` | Tokens that count toward the total but are not in the four buckets (for example Gemini thoughts). Set `extraBilledAsOutput: true` when they are billed at the output rate. |
| `reasoningOutputTokens` | Informational only; shown in session metadata. |
| `timestamp` | Epoch milliseconds of the request. |
| `sessionId`, `projectPath` | Grouping keys for session reports. |
| `model` | The model id as logged; shown in reports. |

Pricing hooks, all optional:

- `costUSD`: the cost the log already recorded. With the default `auto` mode it wins over the computed price.
- `pricingCandidates`: model ids to try in order (for example with provider prefixes). `candidateRule: "first-found"` stops at the first id with a price even if it prices at zero.
- `pricingModel`: price under a different id than the displayed `model`.
- `speed: "fast"`: apply the model's fast-tier multiplier.
- `exactPricingCandidates`: ids tried first, but only when the pricing table has an exact entry for them (no fuzzy matching).
- `overridePricingCandidates`: ids tried first when the user's config has a `pricingOverrides` entry for them.
- `cacheCreationBilledAsInput: true`: bill cache-write tokens at the input rate while still showing them as cache creation.
- `messageCount`: request or message count, summed into `messageCount` in JSON rows.

Skip records whose token counts are all zero, and deduplicate inside the adapter when the tool can log the same request twice (resumed or forked sessions, retries).

## 4. Heavy logs: parse in workers

If the data is large, implement `parseFiles(files, options)` to return one result array per file and call `parseFilesParallel` from `src/core/pool.ts` inside `load`. The worker looks the adapter up by `id`, so no other registration is needed. Worker results cross a thread boundary, so return plain data.

## 5. Optional hooks

- `reportJson(kind, entries, options)`: a custom JSON shape for `tokenburn <id> <report> --json` when an existing tool's schema must be matched (Codex uses this).
- `sessionStyle`: `"claude"` (activity fields, cost-sorted), `"generic"` (default, id-sorted), `"generic-with-activity"` (activity fields, sessions filtered by last activity) or `"entries-with-activity"` (activity fields, entries filtered by date before grouping, as most ccusage adapters do).
- `emptyTotalsNull`: print `"totals": null` for an empty single-agent report.

## 6. Verify against real data

Run `bun src/cli.ts <id> daily --json --offline` and `bun src/cli.ts <id> session --json --offline`, then check the totals against the tool's own numbers: a direct scan of its logs, its built-in usage command, or ccusage where it supports the agent (`bun run parity`). Log formats of agent CLIs are internal and change between releases, so record the CLI version you verified against in the adapter's pull request.
