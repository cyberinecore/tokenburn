import type { WeekDay } from "./types.ts";

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timezone: string | undefined): Intl.DateTimeFormat => {
  const key = timezone ?? "";
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(key, formatter);
  }
  return formatter;
};

export const resolveTimezone = (value: string | undefined): string | undefined => {
  if (!value || value.toLowerCase() === "local") return undefined;
  if (value.toUpperCase() === "UTC") return "UTC";
  return value;
};

export const isValidTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: resolveTimezone(value) });
    return true;
  } catch {
    return false;
  }
};

export const dateKey = (timestamp: number, timezone: string | undefined): string => {
  const parts = formatterFor(timezone).formatToParts(timestamp);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};

export const compactDate = (date: string): string => date.replaceAll("-", "");

export const normalizeDateBound = (value: string): string => {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid date "${value}": expected YYYY-MM-DD or YYYYMMDD`);
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    throw new Error(`Invalid date "${value}": not a real calendar date`);
  }
  return `${y}${m}${d}`;
};

export const withinRange = (date: string, since?: string, until?: string): boolean => {
  const value = compactDate(date);
  return (!since || value >= since) && (!until || value <= until);
};

const WEEKDAYS: WeekDay[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export const parseWeekDay = (value: string): WeekDay => {
  const day = value.toLowerCase() as WeekDay;
  if (!WEEKDAYS.includes(day)) throw new Error(`Invalid week day "${value}"`);
  return day;
};

export const weekStart = (date: string, start: WeekDay): string => {
  const [y, m, d] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(y!, m! - 1, d!));
  const shift = (utc.getUTCDay() - WEEKDAYS.indexOf(start) + 7) % 7;
  utc.setUTCDate(utc.getUTCDate() - shift);
  return utc.toISOString().slice(0, 10);
};

export const rfc3339Millis = (timestamp: number): string => new Date(timestamp).toISOString();

export const lastPeriodsSince = (unit: "day" | "week" | "month", count: number, today: string, start: WeekDay): string => {
  const earlier = Math.max(count, 1) - 1;
  const base = unit === "week" ? weekStart(today, start) : unit === "month" ? `${today.slice(0, 7)}-01` : today;
  const [y, m, d] = base.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  if (unit === "day") date.setUTCDate(date.getUTCDate() - earlier);
  else if (unit === "week") date.setUTCDate(date.getUTCDate() - earlier * 7);
  else date.setUTCMonth(date.getUTCMonth() - earlier);
  return date.toISOString().slice(0, 10).replaceAll("-", "");
};

export const startOfDayMs = (compact: string, timezone: string | undefined): number | undefined => {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(compact);
  if (!match) return undefined;
  const target = `${match[1]}-${match[2]}-${match[3]}`;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let lo = utc - 30 * 3_600_000;
  let hi = utc + 30 * 3_600_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateKey(mid, timezone) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
};

export const nextCompactDate = (compact: string): string => {
  const date = new Date(Date.UTC(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8)) + 1));
  return date.toISOString().slice(0, 10).replaceAll("-", "");
};
