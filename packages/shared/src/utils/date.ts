/**
 * Convert a Date to local date string in a specific timezone.
 * @returns "2026-04-06" format
 */
export function toLocalDate(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

/**
 * Convert a Date to local hour (0-23) in a specific timezone.
 */
export function toLocalHour(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  });
  return Number.parseInt(formatter.format(date), 10);
}

/**
 * Check if a date is within a time range (inclusive).
 */
export function isWithinRange(date: Date, start: Date, end: Date): boolean {
  const t = date.getTime();
  return t >= start.getTime() && t <= end.getTime();
}
