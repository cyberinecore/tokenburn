import { readFileSync } from "node:fs";
const [a, b, agent, key = "daily", until = "2026-09-27"] = process.argv.slice(2);
const rows = (p: string) => {
  const j = JSON.parse(readFileSync(p!, "utf8"));
  const m = new Map<string, any>();
  for (const r of j[key!] ?? []) for (const x of r.agents ?? []) if (x.agent === agent) m.set(r.period, x);
  return m;
};
const A = rows(a!), B = rows(b!);
const fields = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens"];
let compared = 0, bad = 0, costDiff = 0, costTotalA = 0, costTotalB = 0;
for (const p of new Set([...A.keys(), ...B.keys()])) {
  if (p > until!) continue;
  const x = A.get(p), y = B.get(p);
  if (!x || !y) { bad++; if (bad < 10) console.log(`only in ${x ? "tokenburn" : "ccusage"}: ${p}`); continue; }
  compared++; costTotalA += x.totalCost; costTotalB += y.totalCost;
  const diffs = fields.filter((f) => x[f] !== y[f]);
  const cd = Math.abs(x.totalCost - y.totalCost); costDiff = Math.max(costDiff, cd);
  if (diffs.length || cd > Math.max(0.005 * y.totalCost, 0.01)) { bad++; if (bad < 10) console.log(p, diffs.map((f) => `${f} ${x[f]} vs ${y[f]}`).join(" | "), `cost ${x.totalCost} vs ${y.totalCost}`); }
}
console.log(`${agent}: compared ${compared}, mismatches ${bad}, max cost diff ${costDiff.toFixed(6)}, total cost ${costTotalA.toFixed(2)} vs ${costTotalB.toFixed(2)}`);
