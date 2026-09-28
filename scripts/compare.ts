import { readFileSync } from "node:fs";
const [a, b, key = "daily", idKey = "date", until = "9999"] = process.argv.slice(2);
const load = (p: string) => JSON.parse(readFileSync(p!, "utf8"));
const A = load(a!), B = load(b!);
const index = (rows: any[]) => new Map(rows.map((r) => [r[idKey] ?? r.period, r]));
const ra = index(A[key] ?? []), rb = index(B[key] ?? []);
const fields = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens", "totalCost"];
let mismatches = 0, compared = 0;
for (const id of new Set([...ra.keys(), ...rb.keys()])) {
  if (String(id) > until) continue;
  const x = ra.get(id), y = rb.get(id);
  if (!x || !y) { if (x || y) { mismatches++; console.log(`only in ${x ? "A" : "B"}: ${id}`); } continue; }
  compared++;
  const diffs = fields.filter((f) => f === "totalCost" ? Math.abs((x[f] ?? 0) - (y[f] ?? 0)) > Math.max(0.005 * Math.abs(y[f] ?? 0), 0.01) : x[f] !== y[f]);
  if (diffs.length) { mismatches++; if (mismatches <= 15) console.log(id, diffs.map((f) => `${f}: ${x[f]} vs ${y[f]}`).join(" | ")); }
}
console.log(`compared ${compared}, mismatches ${mismatches}`);
