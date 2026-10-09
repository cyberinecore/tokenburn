# tokenburn

Token usage and cost reports for every coding agent CLI on your machine, in one table.

tokenburn reads the local logs that Claude Code, Codex, OpenCode, Gemini CLI, Qwen, Muse Code, Command Code, Amp, Droid, Codebuff, Hermes Agent, pi-agent, Goose, Kilo CLI, GitHub Copilot CLI, Antigravity, Kimi, OpenClaw, Grok Build CLI, ZCode, Cline, Continue and Cyberine already write, prices every request, and reports usage by day, week, month, session or 5-hour billing block. For the agents both tools support, its reports and JSON output match [ccusage](https://github.com/ccusage/ccusage) exactly, and it adds agents ccusage does not read.

Nothing leaves your machine except an optional pricing refresh from LiteLLM (skip it with `--offline`).

## Install

```sh
npx @cyberine/tokenburn
# or
bunx @cyberine/tokenburn
# or install globally
npm install -g @cyberine/tokenburn
tokenburn
```

Runs on Node.js 22.13+ or Bun. The SQLite-backed agents (OpenCode, Hermes, Goose, Kilo, Antigravity, OpenClaw, ZCode, Continue) use the built-in `node:sqlite`; on an older Node.js tokenburn prints one warning naming the requirement and skips them.

## Usage

```sh
tokenburn                      # all agents, grouped by day (same as: tokenburn daily)
tokenburn weekly               # all agents, grouped by ISO week (Monday start)
tokenburn monthly
tokenburn session              # one row per agent session, most expensive first
tokenburn daily --by-agent --json
tokenburn --last 7             # the last 7 days
tokenburn daily --since 2026-09-01 --until 2026-09-30

tokenburn claude daily         # one agent only
tokenburn codex session
tokenburn muse weekly
tokenburn commandcode monthly --breakdown

tokenburn blocks               # Claude Code 5-hour billing blocks
tokenburn blocks --active --token-limit max
tokenburn statusline           # Claude Code status line (reads the hook JSON on stdin)
tokenburn agents               # which agents have data on this machine, and where
```

### Options

| Option | Meaning |
|---|---|
| `-j, --json` | JSON output (ccusage-compatible schema) |
| `-s, --since`, `-u, --until` | Date bounds, `YYYY-MM-DD` or `YYYYMMDD`, inclusive |
| `--last <N>` | Only the most recent N days, weeks or months (1 is the current one); for `session`, sessions active in the last N days |
| `-z, --timezone <tz>` | IANA timezone, `UTC` or `local` for date grouping |
| `--by-agent` | Add per-agent breakdowns to unified JSON rows |
| `--sections daily,weekly,...` | Several unified sections from one load |
| `-b, --breakdown` | Per-model rows in tables |
| `-m, --mode auto\|calculate\|display` | Claude cost source: recorded `costUSD`, recomputed, or recorded only |
| `-o, --order asc\|desc` | Sort order |
| `-w, --start-of-week <day>` | Week start for single-agent weekly reports (default Sunday) |
| `-i, --id <sessionId>` | Detail for one session (single-agent session report) |
| `-O, --offline` | Use the embedded pricing snapshot only |
| `--compact`, `--no-cost`, `--color`, `--no-color` | Output shaping (`NO_COLOR` and `FORCE_COLOR` are honored) |
| `-q, --jq <filter>` | Pipe JSON through `jq` |
| `--config <path>` | Config file (see below) |
| `-d, --debug` | Per-agent load timings on stderr |

`tokenburn codex:daily` style arguments work too.

## Supported agents

| Agent | `id` | Data read | Override |
|---|---|---|---|
| Claude Code | `claude` | `~/.config/claude/projects/**/*.jsonl`, `~/.claude/projects/**/*.jsonl` | `CLAUDE_CONFIG_DIR` (comma list) |
| Codex | `codex` | `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl` | `CODEX_HOME` (comma list) |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db` (+ legacy `storage/message/**/*.json`) | `OPENCODE_DATA_DIR` |
| Gemini CLI | `gemini` | `~/.gemini/tmp/**/*.json(l)` | `GEMINI_DATA_DIR` |
| Qwen | `qwen` | `~/.qwen/projects/*/chats/*.jsonl` | `QWEN_DATA_DIR` |
| Muse Code | `muse` | `~/.local/share/muse/sessions/.msp-view-v1/*/journal-*.bin`, timestamps from `sessions/YYYY/MM/DD/<id>/session.jsonl` | `MUSE_DATA_DIR` |
| Command Code | `commandcode` | `~/.commandcode/projects/*/*.jsonl` (interactive), `~/.local/share/nf-commandcode/jobs/*/stdout.jsonl` (headless `-p` runs) | `COMMANDCODE_HOME`, `COMMANDCODE_JOBS_DIR` |
| Amp | `amp` | `~/.local/share/amp/threads/**/*.json` | `AMP_DATA_DIR` (comma list) |
| Droid (Factory) | `droid` | `~/.factory/sessions/**/*.settings.json` | `DROID_SESSIONS_DIR` (comma list) |
| Codebuff | `codebuff` | `~/.config/manicode{,-dev,-staging}/projects/*/chats/*/chat-messages.json` | `CODEBUFF_DATA_DIR` (comma list) |
| Hermes Agent | `hermes` | `~/.hermes/state.db` (SQLite `sessions` table) | `HERMES_HOME` (comma list) |
| pi-agent | `pi` | `~/.pi/agent/sessions/**/*.jsonl` (skips `subagent-artifacts/`) | `PI_AGENT_DIR` (comma list) |
| Goose | `goose` | `~/.local/share/goose/sessions/sessions.db`, `~/Library/Application Support/goose/sessions/sessions.db`, `~/.local/share/Block/goose/sessions/sessions.db` | `GOOSE_PATH_ROOT` (`<root>/data/sessions/sessions.db`) |
| Kilo CLI | `kilo` | `~/.local/share/kilo/kilo.db` (SQLite `message` table) | `KILO_DATA_DIR` (comma list) |
| GitHub Copilot CLI | `copilot` | `~/.copilot/otel/**/*.jsonl`, `~/.copilot/session-state/*/events.jsonl` | `COPILOT_HOME`, `COPILOT_OTEL_FILE_EXPORTER_PATH` |
| Antigravity | `antigravity` | `~/.gemini/antigravity{,-cli,-ide,-backup}/conversations/*.db`, `~/.config/antigravity/conversations/*.db` | `ANTIGRAVITY_DATA_DIR` (comma list) |
| Kimi CLI and Kimi Code | `kimi` | `~/.kimi/sessions/**/wire.jsonl`, `~/.kimi-code/sessions/**/wire.jsonl` | `KIMI_DATA_DIR` (comma list) |
| OpenClaw | `openclaw` | `~/.openclaw/**/*.jsonl` (+ `.jsonl.deleted.*`, `.jsonl.reset.*`), `~/.openclaw/agents/*/agent/openclaw-agent.sqlite`; also `~/.clawdbot`, `~/.moltbot`, `~/.moldbot` | `OPENCLAW_DIR` (comma list) |
| Grok Build CLI | `grok` | `~/.grok/sessions/**/updates.jsonl` (+ sibling `summary.json`) | `GROK_HOME` |
| ZCode | `zcode` | `~/.zcode/cli/db/db.sqlite` (SQLite `model_usage` joined to `session`) | `ZCODE_HOME` (comma list) |
| Cline | `cline` | `~/.cline/data/tasks/*/ui_messages.json`, `~/.cline/data/sessions/*/<id>.messages.json`, VS Code-family `User/globalStorage/saoudrizwan.claude-dev/tasks/*` | `CLINE_SESSION_DATA_DIR` (comma list) |
| Continue | `continue` | `~/.continue/dev_data/devdata.sqlite` (`tokens_generated`), else `~/.continue/dev_data/0.2.0/tokensGenerated.jsonl` | `CONTINUE_GLOBAL_DIR` |
| Cyberine | `cyberine` | `~/.cyberine/runs/*.json` (index) to each run's `run.json`, `~/.cyberine/chat-sessions/*.json` | `CYBERINE_HOME` (comma list) |

Adding another agent is one file plus one line in the registry; see [docs/adding-a-provider.md](docs/adding-a-provider.md).

### How each agent is counted

- **Claude Code**: one entry per API response, deduplicated by `message.id` + `requestId` (multi-block responses and sidechain replays are counted once).
- **Codex**: `token_count` events, turning cumulative totals into per-request deltas; forked sessions do not recount the parent's replayed history. Long-context requests and the `fast` service tier are priced per request.
- **OpenCode**: assistant messages from `message` and `session_message`, fork copies skipped; session-level totals fill in sessions without messages in `session` reports.
- **Muse Code**: every `session/tokenUsage` record in the session journal, one per model call, timestamped from the source record it points at.
- **Command Code**: interactive transcripts carry per-message usage and billed cost. Headless runs (`command-code -p`) do not write a transcript, so their usage comes from the job logs of the `nf-commandcode` wrapper: one entry per `model_request_end` event, timestamped at the job start. Free models (`:free`, `-free`) cost $0.
- **Amp**: `usageLedger.events[]` per thread (tokens and credits), cache tokens joined from the assistant message each event points at; threads without a ledger use each assistant message's `usage`.
- **Droid**: one entry per session from the cumulative `tokenUsage` in each `*.settings.json` (latest snapshot wins per session id); thinking tokens are billed as output; model names are normalized and priced with provider prefixes from `providerLock`.
- **Codebuff**: assistant messages in each `chat-messages.json`, usage taken from message metadata, the Codebuff usage block or the run-state message history, deduplicated by message id; credits are kept alongside the USD estimate.
- **Hermes Agent**: one entry per row of the `sessions` table in `state.db`, deduplicated by session id across homes; the recorded `actual_cost_usd` (else `estimated_cost_usd`) wins when positive, otherwise the tokens are priced with reasoning billed as output; `messageCount` is carried into JSON.
- **pi-agent**: assistant `message` records with `usage`, models shown as `[pi] <model>`; the recorded `usage.cost.total` wins when present. A forked session drops the leading records that replay its parent's active branch up to the fork time, and duplicates across files are counted once.
- **Goose**: one entry per row of the `sessions` table, preferring the accumulated token columns; tokens in the total beyond input and output count as reasoning billed as output; priced as the model, then `<provider>/<model>`.
- **Kilo CLI**: assistant rows of the `message` table, deduplicated by message id; the recorded `cost` wins, otherwise priced as `<provider>/<model>` when that id has an exact price, else the model; reasoning tokens are billed as output.
- **GitHub Copilot CLI**: `session.shutdown` model metrics from session-state, turned from cumulative snapshots into per-resume intervals, plus OpenTelemetry chat spans (inference logs, agent turns and agent summaries only where no finer record covers the same trace or response). Telemetry older than the latest shutdown of the same session and model is dropped; request counts appear as `messageCount`.
- **Antigravity**: protobuf usage blocks (and retries) in each conversation database's `steps` and `gen_metadata` tables, merged across databases by response, provider-message and message id; model ids and display names map to pricing ids, and Google-hosted requests also try provider-prefixed prices.
- **Kimi CLI and Kimi Code**: `StatusUpdate` token usage from old-layout wire files (model from `config.json`) and turn-scoped `usage.record` lines from Kimi Code agent wire files; `kimi-for-coding` is priced as Kimi K2.5 or K2.6 depending on the request date.
- **OpenClaw**: assistant `message` records with `usage` from session transcripts and the per-agent SQLite `transcript_events` table, tracking the active model through `model_change` records; models show as `[openclaw] <model>` and the recorded `usage.cost.total` wins. A SQLite row replaces its migrated JSONL copy.
- **Grok Build CLI**: `turn_completed` updates, one entry per model in `modelUsage`; input includes cache reads and is split into uncached, cache-read and cache-write parts. The recorded `costUsdTicks` (1e-10 USD) wins; otherwise the model is priced exactly first, then with `xai/` prefixes and without `-build`.
- **ZCode**: completed rows of `model_usage`, input split into uncached, cache-read and cache-write parts; Z.ai models (by provider, or `glm-` without one) try `zai/` prices first and bill cache writes at the input rate. Models of other providers are priced only through `pricingOverrides`.
- **Cline**: one entry per `api_req_started` record (tokens and cost Cline recorded, model from `modelInfo` or the task's model switches) for the CLI and the VS Code, Cursor, VSCodium and Windsurf extensions, plus `metrics` on newer CLI session messages; the recorded cost wins when positive.
- **Continue**: one entry per `tokens_generated` row (prompt and generated tokens, no cache split; timestamps are UTC); sessions are grouped by day because the log keeps no session id. Free-trial and local providers (Ollama, LM Studio, llama.cpp) cost $0; `-latest` model aliases are priced as the base model.
- **Cyberine**: one entry per fleet worker run that calls a provider API in-process (DeepSeek, Xiaomi MiMo, OpenRouter, Moonshot, and so on), with `cacheHitTokens` as cache read and the rest of `inputTokens` as uncached input; CLI-backed lanes (Claude, Codex, Muse, OpenCode, Command Code) are skipped because their own adapters already count them. Subscription and free lanes cost $0. Chat sessions give one entry per `cacheLedger` call (OpenRouter `billedUsd` wins when present), else one entry per session from `sessionTokens` with `plannerUsd` as the recorded cost. Runs whose `run.json` was deleted are not counted. DeepSeek direct is priced on its live schedule: weekday peak hours (01:00-04:00 and 06:00-10:00 UTC) cost twice the off-peak rate, and `deepseek-v4-flash` bills at the `deepseek-flash` (V4.1 Flash) rate from 2026-09-10.

## Pricing

Costs are API list-price equivalents in USD. The embedded snapshot combines LiteLLM model prices, the models.dev catalog and a small built-in table, resolved the same way ccusage resolves them (provider prefixes, `.`/`@` spellings, date suffixes, longest match, 200k long-context tiers, 1-hour cache writes, DeepSeek V4 peak/off-peak schedule). Without `--offline`, tokenburn refreshes LiteLLM prices once an hour into `~/.cache/tokenburn/litellm.json`.

Models with no known price show `$0.00` and a `WARN Missing pricing` line; add a price in the config file:

```json
{
  "pricingOverrides": {
    "my-model": { "inputCostPerToken": 0.000001, "outputCostPerToken": 0.000004, "cacheReadInputTokenCost": 0.0000001 }
  }
}
```

## Config file

The first file found wins: `--config <path>`, `./.tokenburn/config.json`, `$XDG_CONFIG_HOME/tokenburn/config.json` (`~/.config/tokenburn/config.json`), `~/.tokenburn/config.json`. Its shape follows ccusage's: option defaults under `defaults`, per-report options under `commands.<report>`, per-agent options under `<agent>.defaults` and `<agent>.commands.<report>`, plus `pricingOverrides`.

```json
{
  "defaults": { "timezone": "Asia/Ho_Chi_Minh", "offline": true },
  "commands": { "daily": { "breakdown": true } },
  "codex": { "defaults": { "since": "20260101" } }
}
```

Model names can be aliased with `TOKENBURN_MODEL_ALIASES` (or `CCUSAGE_MODEL_ALIASES`), for example `TOKENBURN_MODEL_ALIASES='my-proxy-opus=claude-opus-5-5'`.

## Claude Code status line

```json
{
  "statusLine": { "type": "command", "command": "npx -y @cyberine/tokenburn statusline" }
}
```

Output: `Opus 5.5 (high) | Cost: $1.20 session / $45.30 today / $12.10 block (2h 5m left) | Burn: $6.40/hr (Normal) | Context: 120,433 (12%)`. The line is cached per session for a second and uses the embedded pricing unless `--no-offline` is passed.

## ccusage compatibility

For every agent ccusage 20.0.26 also reads (Claude Code, Codex, OpenCode, Gemini CLI, Qwen, Amp, Droid, Codebuff, Hermes Agent, pi-agent, Goose, Kilo CLI, GitHub Copilot CLI, Antigravity, Kimi, OpenClaw, Grok Build CLI and ZCode), `tokenburn <agent> <report> --json` and the unified reports produce the same keys and values as ccusage 20.0.26 on the same data (`bun run parity` checks every shared agent that has data on the machine against ccusage and prints a skip line for the rest). Differences: whole-number costs print as `0` instead of `0.0`, the status line uses text labels instead of emoji, and the unified reports include the extra agents.

## Performance

Files are parsed in worker threads (set `TOKENBURN_THREADS`, or `TOKENBURN_NO_WORKERS=1` to disable). `--since` and `--last` skip log files that were last written before the window.

## Development

```sh
bun install
bun run dev -- daily --offline
bun run typecheck
bun run build        # dist/cli.js + dist/workers/parse-worker.js for Node
bun run parity       # compare against ccusage on this machine
bun run pricing:update
```

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for ccusage, LiteLLM and models.dev attribution.
