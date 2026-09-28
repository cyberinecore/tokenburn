type Row = Record<string, unknown>;

export type ReadonlyDb = {
  all(sql: string): Row[];
  close(): void;
};

let warned = false;

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
    if (!warned && process.env.TOKENBURN_DEBUG) {
      warned = true;
      console.error(`tokenburn: sqlite unavailable (${(error as Error).message})`);
    }
    return undefined;
  }
}
