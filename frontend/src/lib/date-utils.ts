/**
 * Date utilities for consistent time handling across the app
 * Uses ISO week definition (Monday as first day of week)
 */

/**
 * Get start of day (00:00:00.000) in local timezone
 */
export function getStartOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

/**
 * Get end of day (23:59:59.999) in local timezone
 */
export function getEndOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

/**
 * Get Monday of the week containing the given date (ISO week)
 */
export function getWeekMonday(date: Date): Date {
  const result = new Date(date);
  const day = result.getDay();
  // getDay() returns 0 for Sunday, 1 for Monday, etc.
  // For ISO week, Monday is day 1, so we need to adjust Sunday (0) to be day 7
  const diff = result.getDate() - day + (day === 0 ? -6 : 1);
  result.setDate(diff);
  return getStartOfDay(result);
}

/**
 * Get Sunday of the week containing the given date (ISO week)
 */
export function getWeekSunday(date: Date): Date {
  const monday = getWeekMonday(date);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return getEndOfDay(sunday);
}

/**
 * Get first day of the month containing the given date
 */
export function getMonthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Get last day of the month containing the given date
 */
export function getMonthEnd(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

/**
 * Format date to YYYY-MM-DD string in local timezone
 */
export function toDateString(date: Date): string {
  return date.toLocaleDateString("en-CA"); // Returns YYYY-MM-DD
}

/**
 * Format date to YYYY-MM string in local timezone
 */
export function toMonthString(date: Date): string {
  return toDateString(date).substring(0, 7);
}

/**
 * Calculate date range for different summary types
 */
export function getDateRangeForType(
  type: "daily" | "weekly" | "monthly" | "yearly",
  referenceDate: Date = new Date(),
  year?: number
): { start: Date; end: Date; startStr: string; endStr: string } {
  let start: Date;
  let end: Date;

  switch (type) {
    case "daily":
      start = getStartOfDay(referenceDate);
      end = getEndOfDay(referenceDate);
      break;
    case "weekly":
      start = getWeekMonday(referenceDate);
      end = getWeekSunday(referenceDate);
      break;
    case "monthly":
      start = getMonthStart(referenceDate);
      end = getMonthEnd(referenceDate);
      break;
    case "yearly": {
      const y = year || referenceDate.getFullYear();
      start = new Date(y, 0, 1);
      end = new Date(y, 11, 31, 23, 59, 59, 999);
      break;
    }
  }

  return {
    start,
    end,
    startStr: toDateString(start),
    endStr: toDateString(end),
  };
}
