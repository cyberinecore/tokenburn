import { spawnSync } from "node:child_process";
import { ADAPTERS } from "../src/adapters/registry.ts";

const CCUSAGE = process.env.CCUSAGE_BIN ?? "ccusage@20.0.26";
const REPORTS: [string, string][] = [
  ["daily", "daily"],
  ["session", "sessions"],
];
const COMBINED = new Set(["daily", "monthly", "weekly", "session", "blocks", "statusline"]);
const FIELDS = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens"];

const exec = (cmd: string, args: string[]) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
};

const ccusageAgents = (): Set<string> => {
  const help = exec("bunx", [CCUSAGE, "--help"]);
  const section = help.slice(help.indexOf("COMMANDS:") + "COMMANDS:".length).split(/\n\s*\n/)[0] ?? "";
  const names = section
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name): name is string => Boolean(name) && !COMBINED.has(name!));
  return new Set(names);
};

const until = process.argv[2] ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
const theirAgents = ccusageAgents();
const shared = ADAPTERS.filter((adapter) => theirAgents.has(adapter.id));
let failures = 0;
for (const adapter of shared) {
  if (!adapter.hasData()) {
    console.log(`${adapter.id}: skipped, no local data`);
    continue;
  }
  for (const [report, key] of REPORTS) {
    const args = [adapter.id, report, "--json", "--offline", "--until", until];
    const ours = JSON.parse(exec("bun", ["src/cli.ts", ...args]));
    const theirs = JSON.parse(exec("bunx", [CCUSAGE, ...args]));
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
    console.log(`${adapter.id} ${report}: ${a.size} rows, ${bad} mismatches`);
  }
}
const ourOnly = ADAPTERS.filter((adapter) => !theirAgents.has(adapter.id)).map((adapter) => adapter.id);
if (ourOnly.length) console.log(`not in ccusage: ${ourOnly.join(", ")}`);
process.exit(failures ? 1 : 0);
