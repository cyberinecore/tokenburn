import { isMainThread } from "node:worker_threads";

type Row = Record<string, unknown>;

export type ReadonlyDb = {
  all(sql: string): Row[];
  close(): void;
};

let warned = false;

// DECISION: the Node floor is engines >=22.13 plus a one-time stderr warning, not Node 20 support with silent skips, because Node 20 is end-of-life and a missing node:sqlite would otherwise hide SQLite-backed usage.
const NODE_SQLITE_REQUIREMENT = "Node.js 22.13+ (node:sqlite) or Bun";

export async function openReadonly(path: string): Promise<ReadonlyDb | undefined> {
  try {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
      const { Database } = await import("bun:sqlite");
      const db = new Database(path, { readonly: true });
      return { all: (sql) => db.query(sql).all() as Row[], close: () => db.close() };
    }
    const emit = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      if (String(warning).includes("SQLite")) return;
      (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    const { DatabaseSync } = await import("node:sqlite");
    process.emitWarning = emit;
    const db = new DatabaseSync(path, { readOnly: true });
    return { all: (sql) => db.prepare(sql).all() as Row[], close: () => db.close() };
  } catch (error) {
    if (!warned && isMainThread) {
      warned = true;
      const detail = process.env.TOKENBURN_DEBUG ? ` (${(error as Error).message})` : "";
      console.error(`tokenburn: cannot read ${path}: SQLite needs ${NODE_SQLITE_REQUIREMENT}, running Node.js ${process.versions.node}${detail}`);
    }
    return undefined;
  }
}

export async function probeSqlite(path: string): Promise<void> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return;
  try {
    await import("node:sqlite");
  } catch {
    (await openReadonly(path))?.close();
  }
}
