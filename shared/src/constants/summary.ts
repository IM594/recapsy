export const SUMMARY_TYPES = {
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
  yearly: "yearly",
} as const;

export type SharedSummaryType =
  (typeof SUMMARY_TYPES)[keyof typeof SUMMARY_TYPES];

export const SUMMARY_TYPE_LIST = Object.values(SUMMARY_TYPES) as SharedSummaryType[];

export function isSummaryType(value: unknown): value is SharedSummaryType {
  return typeof value === "string" && (SUMMARY_TYPE_LIST as readonly string[]).includes(value);
}
