let cache: Map<string, string> | undefined;

const parseAliases = (raw: string): Map<string, string> => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return new Map(Object.entries(JSON.parse(trimmed) as Record<string, string>));
    } catch {}
  }
  const inner = trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed.slice(1, -1) : trimmed;
  const map = new Map<string, string>();
  for (const pair of inner.split(/[,;\n]/)) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    const from = pair.slice(0, at).trim();
    const to = pair.slice(at + 1).trim();
    if (from && to) map.set(from, to);
  }
  return map;
};

const aliases = (): Map<string, string> => {
  cache ??= parseAliases(process.env.TOKENBURN_MODEL_ALIASES ?? process.env.CCUSAGE_MODEL_ALIASES ?? "");
  return cache;
};

export const resolveModelAlias = (model: string): string => {
  const map = aliases();
  if (map.size === 0) return model;
  const direct = map.get(model);
  if (direct) return direct;
  if (model.endsWith("-fast")) {
    const base = map.get(model.slice(0, -5));
    if (base) return `${base}-fast`;
  }
  return model;
};
