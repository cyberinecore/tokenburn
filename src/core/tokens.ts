export type BaseUsage = { input: number; output: number; cacheCreation: number; cacheRead: number };

export const lenientUint = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return 0;
};

export const applyTotalTokenFallback = (usage: BaseUsage, extra: number, total: number): { usage: BaseUsage; extra: number } => {
  const known = usage.input + usage.output + usage.cacheCreation + usage.cacheRead + extra;
  const missing = Math.max(total - known, 0);
  if (missing === 0) return { usage, extra };
  if (usage.output === 0) return { usage: { ...usage, output: missing }, extra };
  return { usage, extra: extra + missing };
};
