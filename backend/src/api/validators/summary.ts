import { isSummaryType, isYm, isYmd, type SharedSummaryType } from "@recaply/shared";
import { badRequest } from "../../lib/errors";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseIntFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function parseYear(value: unknown, fallbackYear: number): number {
  if (value === undefined || value === null || value === "") return fallbackYear;

  const parsed = parseIntFromUnknown(value);
  if (!parsed || !Number.isFinite(parsed)) {
    throw badRequest("Invalid year", { year: value });
  }

  const year = Math.trunc(parsed);
  if (year < 1970 || year > 3000) {
    throw badRequest("Year out of range", { year });
  }

  return year;
}

function parseStringArray(value: unknown, field: string, opts?: { allowEmpty?: boolean }): string[] {
  if (!Array.isArray(value)) {
    throw badRequest(`Invalid ${field}`, { [field]: value });
  }

  const items = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);

  if (!opts?.allowEmpty && items.length === 0) {
    throw badRequest(`${field} is required`, { [field]: value });
  }

  return items;
}

export type GenerateSummaryRequest = {
  selectedRepos: string[];
  since: string;
  until: string;
  summaryType: SharedSummaryType;
  author: string;
  year: number;
};

export function parseGenerateSummaryBody(body: unknown): GenerateSummaryRequest {
  if (!isRecord(body)) throw badRequest("Invalid request body", { bodyType: typeof body });

  const currentYear = new Date().getFullYear();
  const year = parseYear(body.year, currentYear);

  const selectedRepos = parseStringArray(body.selectedRepos, "selectedRepos", {
    allowEmpty: false,
  });

  const since = asNonEmptyString(body.since);
  const until = asNonEmptyString(body.until);
  if (!since || !until) {
    throw badRequest("Missing since/until", { since: body.since, until: body.until });
  }

  const rawType = body.summaryType;
  if (!isSummaryType(rawType)) {
    throw badRequest("Invalid summaryType", { summaryType: rawType });
  }

  const author = asNonEmptyString(body.author) ?? "";

  return {
    selectedRepos,
    since,
    until,
    summaryType: rawType,
    author,
    year,
  };
}

export type SummaryDataQuery = {
  type: SharedSummaryType;
  repo?: string;
  year: number;
};

export function parseSummaryDataQuery(query: unknown, keys: { type: string; repo: string; year: string }): SummaryDataQuery {
  if (!isRecord(query)) throw badRequest("Invalid query", { queryType: typeof query });

  const currentYear = new Date().getFullYear();
  const year = parseYear(query[keys.year], currentYear);

  const rawType = query[keys.type];
  if (!isSummaryType(rawType)) {
    throw badRequest("Invalid type parameter", { type: rawType });
  }

  const repo = asNonEmptyString(query[keys.repo]) ?? undefined;

  return { type: rawType, repo, year };
}

export type RegenerateSummaryRequest = {
  type: SharedSummaryType;
  id: string;
  year: number;
  repo?: string;
  customPrompt?: string;
};

export function parseRegenerateSummaryBody(body: unknown): RegenerateSummaryRequest {
  if (!isRecord(body)) throw badRequest("Invalid request body", { bodyType: typeof body });

  const rawType = body.type;
  const id = asNonEmptyString(body.id);
  if (!isSummaryType(rawType)) throw badRequest("Invalid type parameter", { type: rawType });
  if (!id) throw badRequest("Missing id", { id: body.id });

  const currentYear = new Date().getFullYear();
  const year = parseYear(body.year, currentYear);

  const repo = asNonEmptyString(body.repo) ?? undefined;
  const customPrompt = asNonEmptyString(body.customPrompt) ?? undefined;

  if (rawType === "daily") {
    if (!isYmd(id)) throw badRequest("Invalid daily id (expected YYYY-MM-DD)", { id });
    if (!repo) throw badRequest("Missing repo for daily regeneration", { body });
  }

  if (rawType === "weekly") {
    if (!isYmd(id)) throw badRequest("Invalid weekly id (expected YYYY-MM-DD)", { id });
  }

  if (rawType === "monthly") {
    if (!isYm(id)) throw badRequest("Invalid monthly id (expected YYYY-MM)", { id });
  }

  return { type: rawType, id, year, repo, customPrompt };
}
