/**
 * Date utilities for consistent time handling across the app
 * Uses ISO week definition (Monday as first day of week)
 */

import type { SummaryType } from "@/types/summary";
import { SUMMARY_TYPES } from "@recaply/shared";

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
 * Get ISO week number for the given date.
 * ISO weeks start on Monday and week 1 is the week with the year's first Thursday.
 */
export function getIsoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Calculate date range for different summary types
 */
export function getDateRangeForType(
  type: SummaryType,
  referenceDate: Date = new Date(),
  year?: number
): { start: Date; end: Date; startStr: string; endStr: string } {
  let start: Date;
  let end: Date;

  switch (type) {
    case SUMMARY_TYPES.daily:
      start = getStartOfDay(referenceDate);
      end = getEndOfDay(referenceDate);
      break;
    case SUMMARY_TYPES.weekly:
      start = getWeekMonday(referenceDate);
      end = getWeekSunday(referenceDate);
      break;
    case SUMMARY_TYPES.monthly:
      start = getMonthStart(referenceDate);
      end = getMonthEnd(referenceDate);
      break;
    case SUMMARY_TYPES.yearly: {
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
