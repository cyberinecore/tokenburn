# tokenburn

Token usage and cost reports for every coding agent CLI on your machine, in one table.

tokenburn reads the local logs that Claude Code, Codex, OpenCode, Gemini CLI, Qwen, Muse Code and Command Code already write, prices every request, and reports usage by day, week, month, session or 5-hour billing block. For the agents both tools support, its reports and JSON output match [ccusage](https://github.com/ccusage/ccusage) exactly, and it adds agents ccusage does not read.

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

Runs on Node.js 20+ or Bun. OpenCode's SQLite store needs Node.js 22.13+ (built-in `node:sqlite`) or Bun; on older Node versions OpenCode is skipped.

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

Adding another agent is one file plus one line in the registry; see [docs/adding-a-provider.md](docs/adding-a-provider.md).

### How each agent is counted

- **Claude Code**: one entry per API response, deduplicated by `message.id` + `requestId` (multi-block responses and sidechain replays are counted once).
- **Codex**: `token_count` events, turning cumulative totals into per-request deltas; forked sessions do not recount the parent's replayed history. Long-context requests and the `fast` service tier are priced per request.
- **OpenCode**: assistant messages from `message` and `session_message`, fork copies skipped; session-level totals fill in sessions without messages in `session` reports.
- **Muse Code**: every `session/tokenUsage` record in the session journal, one per model call, timestamped from the source record it points at.
- **Command Code**: interactive transcripts carry per-message usage and billed cost. Headless runs (`command-code -p`) do not write a transcript, so their usage comes from the job logs of the `nf-commandcode` wrapper: one entry per `model_request_end` event, timestamped at the job start. Free models (`:free`, `-free`) cost $0.

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

For Claude Code, Codex, OpenCode, Gemini CLI and Qwen, `tokenburn <agent> <report> --json` and the unified reports produce the same keys and values as ccusage 20.0.26 on the same data (`bun run parity` checks this against a local `ccusage`). Differences: whole-number costs print as `0` instead of `0.0`, the status line uses text labels instead of emoji, and the unified reports include the extra agents.

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
