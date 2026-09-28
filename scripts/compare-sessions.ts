import { readFileSync } from "node:fs";
const [a, b, cutoff = "2026-09-27T23:59:59Z"] = process.argv.slice(2);
const load = (p: string) => new Map<string, any>(JSON.parse(readFileSync(p!, "utf8")).session.map((r: any) => [`${r.agent}|${r.period}`, r]));
const A = load(a!), B = load(b!);
const fields = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens"];
const stats = new Map<string, { n: number; bad: number; onlyA: number; onlyB: number }>();
const st = (agent: string) => stats.get(agent) ?? (stats.set(agent, { n: 0, bad: 0, onlyA: 0, onlyB: 0 }), stats.get(agent)!);
let shown = 0;
for (const key of new Set([...A.keys(), ...B.keys()])) {
  const x = A.get(key), y = B.get(key);
  const agent = key.split("|")[0]!;
  const last = (x ?? y).metadata?.lastActivity ?? "";
  if (last > cutoff!) continue;
  if (!x) { st(agent).onlyB++; if (shown++ < 8) console.log("only ccusage", key, last); continue; }
  if (!y) { st(agent).onlyA++; if (shown++ < 8) console.log("only tokenburn", key, last); continue; }
  st(agent).n++;
  const diffs = fields.filter((f) => x[f] !== y[f]);
  const costBad = Math.abs(x.totalCost - y.totalCost) > Math.max(0.005 * y.totalCost, 0.01);
  const metaBad = JSON.stringify(x.metadata) !== JSON.stringify(y.metadata);
  if (diffs.length || costBad || metaBad) { st(agent).bad++; if (shown++ < 8) console.log(key, diffs.join(","), costBad ? `cost ${x.totalCost} vs ${y.totalCost}` : "", metaBad ? `meta ${JSON.stringify(x.metadata)} vs ${JSON.stringify(y.metadata)}` : ""); }
}
for (const [agent, s] of stats) console.log(agent, s);
