import { join } from "node:path";
import { envPaths, home, isDir, listDir } from "../core/fs.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { byTimestamp } from "./common.ts";
import { parseClineCliSession, parseTaskDir, taskDirs } from "./tasklog.ts";

const EXTENSION_ID = "saoudrizwan.claude-dev";
const EDITORS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];

type Store = { root: string; label: string };

export const clineStores = (): Store[] => {
  if (process.env.CLINE_SESSION_DATA_DIR !== undefined) return envPaths("CLINE_SESSION_DATA_DIR").filter(isDir).map((root) => ({ root, label: "Cline" }));
  const stores: Store[] = [{ root: join(home(), ".cline", "data"), label: "Cline" }];
  for (const editor of EDITORS) {
    for (const base of [join(home(), "Library", "Application Support", editor), join(home(), ".config", editor)]) {
      stores.push({ root: join(base, "User", "globalStorage", EXTENSION_ID), label: `Cline (${editor})` });
    }
  }
  return stores.filter((store) => isDir(store.root));
};

const sources = () =>
  clineStores().flatMap((store) => [
    ...taskDirs(join(store.root, "tasks")).map((dir) => ({ kind: "task" as const, dir, label: store.label })),
    ...listDir(join(store.root, "sessions"))
      .map((name) => join(store.root, "sessions", name))
      .filter(isDir)
      .sort()
      .map((dir) => ({ kind: "session" as const, dir, label: store.label })),
  ]);

export const cline: Adapter = {
  id: "cline",
  label: "Cline",
  product: "Cline",
  envVars: ["CLINE_SESSION_DATA_DIR"],
  reports: ["daily", "weekly", "monthly", "session"],
  sessionStyle: "entries-with-activity",
  hasData: () => sources().length > 0,
  async load(): Promise<UsageEntry[]> {
    return sources()
      .flatMap(({ kind, dir, label }) => (kind === "task" ? parseTaskDir(dir, "cline", label) : parseClineCliSession(dir, "cline", label)))
      .sort(byTimestamp);
  },
};
