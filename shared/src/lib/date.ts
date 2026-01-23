const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YM_RE = /^(\d{4})-(\d{2})$/;

export type ParsedYmd = { year: number; month: number; day: number };
export type ParsedYm = { year: number; month: number };

export function parseYmd(value: string): ParsedYmd | null {
  const match = value.match(YMD_RE);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year) return null;
  if (date.getUTCMonth() !== month - 1) return null;
  if (date.getUTCDate() !== day) return null;

  return { year, month, day };
}

export function parseYm(value: string): ParsedYm | null {
  const match = value.match(YM_RE);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;

  return { year, month };
}

export function isYmd(value: unknown): value is string {
  return typeof value === "string" && parseYmd(value) !== null;
}

export function isYm(value: unknown): value is string {
  return typeof value === "string" && parseYm(value) !== null;
}

export function toYmdUtc(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDaysYmd(ymd: string, days: number): string {
  const parsed = parseYmd(ymd);
  if (!parsed) {
    throw new Error(`Invalid date string (expected YYYY-MM-DD): ${ymd}`);
  }

  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  date.setUTCDate(date.getUTCDate() + days);
  return toYmdUtc(date);
}

/**
 * ISO week: Monday as the first day of week.
 * Returns the Monday of the ISO week containing `dateYmd`.
 */
export function getIsoWeekStartYmd(dateYmd: string): string {
  const parsed = parseYmd(dateYmd);
  if (!parsed) {
    throw new Error(`Invalid date string (expected YYYY-MM-DD): ${dateYmd}`);
  }

  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  const day = date.getUTCDay() || 7; // 1..7 (Mon..Sun)
  date.setUTCDate(date.getUTCDate() - (day - 1));
  return toYmdUtc(date);
}

/**
 * ISO week end (Sunday) for a given week start (Monday).
 */
export function getIsoWeekEndYmd(weekStartYmd: string): string {
  return addDaysYmd(weekStartYmd, 6);
}

export function getIsoWeekNumber(date: Date): number;
export function getIsoWeekNumber(dateYmd: string): number;
export function getIsoWeekNumber(input: Date | string): number {
  if (typeof input === "string") {
    const parsed = parseYmd(input);
    if (!parsed) {
      throw new Error(`Invalid date string (expected YYYY-MM-DD): ${input}`);
    }
    const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
    return getIsoWeekNumber(date);
  }

  const d = new Date(Date.UTC(input.getFullYear(), input.getMonth(), input.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

