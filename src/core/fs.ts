import { readdirSync, statSync } from "node:fs";
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
