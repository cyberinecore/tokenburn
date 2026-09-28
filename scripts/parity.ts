import { spawnSync } from "node:child_process";

const CCUSAGE = process.env.CCUSAGE_BIN ?? "ccusage@latest";
const REPORTS: [string, string, string][] = [
  ["claude", "daily", "daily"],
  ["codex", "daily", "daily"],
  ["opencode", "daily", "daily"],
  ["gemini", "daily", "daily"],
  ["claude", "session", "sessions"],
  ["opencode", "session", "sessions"],
];
const FIELDS = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens"];

const run = (cmd: string, args: string[]) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
};

const until = process.argv[2] ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
let failures = 0;
for (const [agent, report, key] of REPORTS) {
  const args = [agent, report, "--json", "--offline", "--until", until];
  const ours = run("bun", ["src/cli.ts", ...args]);
  const theirs = run("bunx", [CCUSAGE, ...args]);
  const id = report === "session" ? "sessionId" : "date";
  const index = (rows: any[]) => new Map((rows ?? []).map((r) => [r[id], r]));
  const a = index(ours[key]);
  const b = index(theirs[key]);
  let bad = 0;
  for (const period of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(period);
    const y = b.get(period);
    const costX = x?.totalCost ?? x?.costUSD ?? 0;
    const costY = y?.totalCost ?? y?.costUSD ?? 0;
    if (!x || !y || FIELDS.some((f) => x[f] !== y[f]) || Math.abs(costX - costY) > Math.max(0.005 * Math.abs(costY), 0.01)) bad++;
  }
  failures += bad;
  console.log(`${agent} ${report}: ${a.size} rows, ${bad} mismatches`);
}
process.exit(failures ? 1 : 0);
