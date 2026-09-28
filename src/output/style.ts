export type Color = "blue" | "green" | "grey" | "red" | "yellow";

const CODES: Record<Color, number> = { blue: 34, green: 32, grey: 90, red: 31, yellow: 33 };

export type Style = { enabled: boolean; color: (text: string, color: Color) => string };

export const makeStyle = (flag: boolean | undefined): Style => {
  let enabled: boolean;
  if (process.env.NO_COLOR !== undefined || flag === false) enabled = false;
  else if (flag === true || (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0")) enabled = true;
  else enabled = Boolean(process.stdout.isTTY);
  return { enabled, color: (text, color) => (enabled && text ? `\x1b[${CODES[color]}m${text}\x1b[39m` : text) };
};

const ANSI = /\x1b\[[0-9;]*m/g;

const isWide = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1faff) ||
  (code >= 0x20000 && code <= 0x3fffd);

export const visibleWidth = (text: string): number => {
  let width = 0;
  for (const char of text.replace(ANSI, "")) {
    const code = char.codePointAt(0)!;
    if (code === 0 || (code >= 0x300 && code <= 0x36f) || code === 0x200d) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
};

export const terminalWidth = (): number => {
  const columns = Number(process.env.COLUMNS);
  if (Number.isInteger(columns) && columns > 0) return columns;
  return process.stdout.columns || 120;
};

export const formatNumber = (value: number): string => Math.round(value).toLocaleString("en-US");

export const formatCurrency = (value: number): string => `$${value.toFixed(2)}`;

export const shortModelName = (model: string): string => {
  const stripped = model.startsWith("anthropic/claude-") ? model.slice(17) : model.startsWith("claude-") ? model.slice(7) : model;
  const parts = stripped.split("-");
  if (parts.length >= 3 && parts[parts.length - 1]!.length === 8) return parts.slice(0, -1).join("-");
  return stripped;
};

export const formatModels = (models: string[]): string =>
  [...new Set(models.map(shortModelName))]
    .sort()
    .map((m) => `- ${m}`)
    .join("\n");
