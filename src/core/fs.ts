import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const home = (): string => process.env.HOME || homedir();

export const expandHome = (path: string): string =>
  path === "~" ? home() : path.startsWith("~/") ? join(home(), path.slice(2)) : path;

export const envPaths = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map(expandHome);

export const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export function* walk(root: string, accept: (name: string) => boolean): Generator<string> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(full, accept);
    else if (entry.isFile() && accept(entry.name)) yield full;
  }
}

export const listDir = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

let scratch = Buffer.allocUnsafe(1 << 20);

// DECISION: bulk log reads go into one reused per-thread buffer, not a fresh readFileSync buffer per file, because zero-filling new pages for gigabytes of logs cost 15-45% of parallel read time; the returned view is only valid until the next call.
export const readFileIntoScratch = (path: string): Buffer => {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > scratch.length) scratch = Buffer.allocUnsafe(Math.max(size, scratch.length * 2));
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, scratch, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return scratch.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
};
