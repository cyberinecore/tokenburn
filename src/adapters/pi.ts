import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { home, isDir } from "../core/fs.ts";
import type { Adapter, UsageEntry } from "../core/types.ts";
import { byTimestamp, filesWithExtension, isObj, nonEmpty, type Obj, parseTsTimestamp, readText, tokenEntry, u64 } from "./common.ts";

export const piRoots = (): string[] => {
  const raw = process.env.PI_AGENT_DIR;
  if (raw !== undefined && raw.trim()) {
    const list = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    return [...new Set(list)].filter(isDir);
  }
  const path = join(home(), ".pi/agent/sessions");
  return isDir(path) ? [path] : [];
};

const isSubagentArtifact = (file: string) => file.split(sep).includes("subagent-artifacts");

const sessionFiles = (root: string): string[] => filesWithExtension(root, "jsonl").filter((file) => !isSubagentArtifact(file));

type Header = { parentSession?: string; parentMalformed: boolean; timestamp?: number };

type Signature = string;

type SessionData = {
  header?: Header;
  signatures: Signature[];
  usageIds: (string | undefined)[];
  path: "linear" | "invalid" | number[];
  entries: (UsageEntry & { dedupId: string })[];
};

const parseLine = (line: string): Obj | undefined => {
  try {
    const value = JSON.parse(line);
    return isObj(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const lineShapeOk = (value: Obj): boolean => {
  const message = value.message;
  if (message === undefined || message === null) return true;
  if (!isObj(message)) return false;
  return message.usage === undefined || message.usage === null || isObj(message.usage);
};

const parseHeader = (content: string): Header | undefined => {
  const value = parseLine(content.split("\n")[0] ?? "");
  if (!value || !lineShapeOk(value)) return undefined;
  if (nonEmpty(value.type) !== "session") return undefined;
  const timestampText = nonEmpty(value.timestamp);
  return {
    parentSession: nonEmpty(value.parentSession),
    parentMalformed: "parentSession" in value && nonEmpty(value.parentSession) === undefined,
    timestamp: timestampText === undefined ? undefined : parseTsTimestamp(timestampText),
  };
};

const hasCycle = (parents: Map<string, string | undefined>): boolean => {
  const validated = new Set<string>();
  for (const start of parents.keys()) {
    if (validated.has(start)) continue;
    const path = new Set<string>();
    let id = start;
    while (!validated.has(id)) {
      if (path.has(id)) return true;
      path.add(id);
      if (!parents.has(id)) return true;
      const parent = parents.get(id);
      if (parent === undefined) break;
      id = parent;
    }
    for (const p of path) validated.add(p);
  }
  return false;
};

const replayPath = (lines: string[], usageIds: (string | undefined)[]): SessionData["path"] => {
  const links = lines
    .map(parseLine)
    .filter((v): v is Obj => Boolean(v))
    .map((v) => ({ type: nonEmpty(v.type), id: nonEmpty(v.id), parentId: nonEmpty(v.parentId) }))
    .filter((link) => link.type !== "session");
  if (links.every((link) => link.id === undefined && link.parentId === undefined)) return "linear";
  const parents = new Map<string, string | undefined>();
  let leaf: string | undefined;
  for (const link of links) {
    if (link.id === undefined) return "invalid";
    if (parents.has(link.id)) return "invalid";
    parents.set(link.id, link.parentId);
    leaf = link.id;
  }
  if (leaf === undefined) return "linear";
  for (const parent of parents.values()) if (parent !== undefined && !parents.has(parent)) return "invalid";
  if (hasCycle(parents)) return "invalid";
  const usageById = new Map<string, number>();
  usageIds.forEach((id, index) => {
    if (id !== undefined) usageById.set(id, index);
  });
  const active: number[] = [];
  const visited = new Set<string>();
  let id = leaf;
  for (;;) {
    if (visited.has(id)) return "invalid";
    visited.add(id);
    const index = usageById.get(id);
    if (index !== undefined) active.push(index);
    if (!parents.has(id)) return "invalid";
    const parent = parents.get(id);
    if (parent === undefined) break;
    id = parent;
  }
  return active.reverse();
};

const extractSessionId = (file: string): string => {
  const stem = basename(file, extname(file)) || "unknown";
  const at = stem.indexOf("_");
  return at < 0 ? stem : stem.slice(at + 1);
};

const extractProject = (file: string): string => {
  const parts = file.split(sep);
  const at = parts.indexOf("sessions");
  return at >= 0 && at + 1 < parts.length ? parts[at + 1]! : "unknown";
};

const parseSessionFile = (file: string): SessionData | undefined => {
  const content = readText(file);
  if (content === undefined) return undefined;
  const project = extractProject(file);
  const sessionId = extractSessionId(file);
  const lines = content.split("\n");
  const data: SessionData = { header: parseHeader(content), signatures: [], usageIds: [], path: "linear", entries: [] };
  for (const line of lines) {
    if (!line.includes('"usage"') || !line.includes('"message"')) continue;
    const record = parseLine(line);
    if (!record) continue;
    if (!lineShapeOk(record)) continue;
    const message = record.message;
    const type = nonEmpty(record.type);
    if (type !== undefined && type !== "message") continue;
    if (!isObj(message) || nonEmpty(message.role) !== "assistant" || !isObj(message.usage)) continue;
    const timestampText = nonEmpty(record.timestamp);
    const timestamp = timestampText === undefined ? undefined : parseTsTimestamp(timestampText);
    if (timestamp === undefined) continue;
    const usage: Obj = message.usage;
    const rawModel = nonEmpty(message.model);
    const model = rawModel === undefined ? undefined : `[pi] ${rawModel}`;
    const costTotal = isObj(usage.cost) && typeof usage.cost.total === "number" ? usage.cost.total : undefined;
    const sourceCost = costTotal !== undefined && Number.isFinite(costTotal) && costTotal >= 0 ? costTotal : undefined;
    const entry = tokenEntry(
      {
        agent: "pi",
        timestamp,
        sessionId,
        projectPath: project,
        model,
        costUSD: sourceCost,
        exactPricingCandidates: model ? [model] : undefined,
        pricingCandidates: rawModel ? [rawModel] : model ? [model] : undefined,
      },
      { input: u64(usage.input), output: u64(usage.output), cacheCreation: u64(usage.cacheWrite), cacheRead: u64(usage.cacheRead) },
      u64(usage.totalTokens),
    );
    if (!entry) continue;
    const tokens = [entry.inputTokens, entry.outputTokens, entry.cacheCreationTokens, entry.cacheReadTokens];
    const effectiveTotal = tokens.reduce((a, b) => a + b, 0) + entry.extraTotalTokens;
    data.signatures.push(JSON.stringify([timestamp, rawModel ?? null, ...tokens, effectiveTotal, sourceCost ?? null]));
    data.usageIds.push(nonEmpty(record.id));
    data.entries.push({
      ...entry,
      dedupId: JSON.stringify(["pi", project, sessionId, timestampText, model ?? "", ...tokens, entry.extraTotalTokens, sourceCost ?? null]),
    });
  }
  data.path = replayPath(lines, data.usageIds);
  return data;
};

const matchingPrefix = (parent: SessionData, child: SessionData, forkTimestamp: number, timestamps: (s: SessionData, i: number) => number): number | undefined => {
  if (child.path === "invalid" || parent.path === "invalid") return undefined;
  const order = parent.path === "linear" ? parent.signatures.map((_, i) => i) : parent.path;
  let count = 0;
  for (const index of order) {
    if (timestamps(parent, index) > forkTimestamp) break;
    if (count >= child.signatures.length || child.signatures[count] !== parent.signatures[index]) break;
    count++;
  }
  return count;
};

const replaySkips = (files: string[], loaded: (SessionData | undefined)[]): Map<number, number> => {
  const byPath = new Map<string, number>();
  files.forEach((file, index) => {
    const key = resolve(file);
    if (!byPath.has(key)) byPath.set(key, index);
  });
  const invalid = new Set<number>();
  loaded.forEach((data, index) => {
    if (!data?.header || data.header.timestamp === undefined || data.header.parentMalformed) invalid.add(index);
  });
  const parentOf = new Map<number, { parent: number; fork: number }>();
  loaded.forEach((data, child) => {
    const header = data?.header;
    if (!header?.parentSession || header.timestamp === undefined) return;
    let parent = byPath.get(resolve(header.parentSession));
    if (parent === undefined && !isAbsolute(header.parentSession)) parent = byPath.get(resolve(dirname(files[child]!), header.parentSession));
    if (parent === undefined || parent === child) {
      invalid.add(child);
      return;
    }
    parentOf.set(child, { parent, fork: header.timestamp });
  });
  const validLineage = (child: number): boolean => {
    const visited = new Set<number>();
    let current = child;
    for (let link = parentOf.get(current); link; link = parentOf.get(current)) {
      if (invalid.has(current) || visited.has(current)) return false;
      visited.add(current);
      current = link.parent;
    }
    return !invalid.has(current);
  };
  const timestampOf = (data: SessionData, index: number) => data.entries[index]!.timestamp;
  const skips = new Map<number, number>();
  for (const [child, link] of parentOf) {
    if (!validLineage(child)) continue;
    const parentData = loaded[link.parent];
    const childData = loaded[child];
    if (!parentData || !childData) continue;
    const matched = matchingPrefix(parentData, childData, link.fork, timestampOf);
    if (matched) skips.set(child, matched);
  }
  return skips;
};

export const pi: Adapter = {
  id: "pi",
  label: "Pi",
  product: "pi-agent",
  envVars: ["PI_AGENT_DIR"],
  reports: ["daily", "monthly", "session"],
  sessionStyle: "entries-with-activity",
  hasData: () => piRoots().some((root) => sessionFiles(root).length > 0),
  async load(): Promise<UsageEntry[]> {
    const files = piRoots().flatMap(sessionFiles);
    const loaded = files.map(parseSessionFile);
    const skips = replaySkips(files, loaded);
    const seen = new Set<string>();
    const entries: UsageEntry[] = [];
    loaded.forEach((data, index) => {
      if (!data) return;
      for (const { dedupId, ...entry } of data.entries.slice(skips.get(index) ?? 0)) {
        if (seen.has(dedupId)) continue;
        seen.add(dedupId);
        entries.push(entry);
      }
    });
    return entries.sort(byTimestamp);
  },
};
