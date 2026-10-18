import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const src = join(root, "src");
const IMPORT = /(?:from|import\(?)\s*["'](\.{1,2}\/[^"']+)["']|["'](\.{1,2}\/[^"']+\.wasm)["']/g;

const closure = (entry: string, seen = new Set<string>()): Set<string> => {
  if (seen.has(entry) || !existsSync(entry)) return seen;
  seen.add(entry);
  if (!entry.endsWith(".ts")) return seen;
  for (const match of readFileSync(entry, "utf8").matchAll(IMPORT)) closure(resolve(dirname(entry), match[1] ?? match[2]!), seen);
  return seen;
};

const parserHashes: Record<string, string> = {};
for (const name of readdirSync(join(src, "adapters")).filter((n) => n.endsWith(".ts"))) {
  const hash = createHash("sha256");
  for (const file of [...closure(join(src, "adapters", name))].sort()) hash.update(file.slice(src.length)).update("\0").update(readFileSync(file)).update("\0");
  parserHashes[name.slice(0, -3)] = hash.digest("hex").slice(0, 16);
}

const result = await Bun.build({
  entrypoints: [join(src, "cli.ts"), join(src, "workers", "parse-worker.ts")],
  outdir: join(root, "dist"),
  root: src,
  target: "node",
  minify: true,
  define: { TOKENBURN_PARSER_HASHES: JSON.stringify(JSON.stringify(parserHashes)) },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
cpSync(join(src, "wasm"), join(root, "dist", "wasm"), { recursive: true });
chmodSync(join(root, "dist", "cli.js"), 0o755);
