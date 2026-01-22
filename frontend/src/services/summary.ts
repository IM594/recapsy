import { getSummaryApiUrl } from "@/lib/api";
import {
  BODY_KEYS,
  CONTENT_TYPES,
  HTTP_HEADERS,
  QUERY_KEYS,
  SUMMARY_ROUTES,
  SUMMARY_TYPES,
} from "@recaply/shared";
import type {
  DailySummaryData,
  GenerationConfig,
  MonthlySummaryData,
  SummaryStatus,
  SummaryType,
  WeeklySummaryData,
  YearlySummaryData,
} from "@/types/summary";
import { ApiError, fetchJson } from "./http";

export async function fetchAvailableYears(): Promise<number[]> {
  const currentYear = new Date().getFullYear();
  const data = await fetchJson<{ years?: number[] }>(
    getSummaryApiUrl(SUMMARY_ROUTES.years)
  );

  const years = new Set<number>([currentYear]);
  for (const y of data.years || []) {
    if (Number.isFinite(y)) years.add(y);
  }

  return Array.from(years).sort((a, b) => b - a);
}

export async function fetchSummaryStatus(year: number): Promise<SummaryStatus> {
  const search = new URLSearchParams({ [QUERY_KEYS.year]: String(year) });
  return fetchJson<SummaryStatus>(
    getSummaryApiUrl(`${SUMMARY_ROUTES.status}?${search}`)
  );
}

export async function resetSummaryStatus(year: number): Promise<SummaryStatus> {
  const data = await fetchJson<{ success: boolean; status: SummaryStatus }>(
    getSummaryApiUrl(SUMMARY_ROUTES.reset),
    {
      method: "POST",
      headers: { [HTTP_HEADERS.contentType]: CONTENT_TYPES.json },
      body: JSON.stringify({ [BODY_KEYS.year]: year }),
    }
  );
  return data.status;
}

type StartGenerationOk = { status: string; message?: string };
type StartGenerationConflict = { error: string; status?: SummaryStatus };

export async function startSummaryGeneration(
  config: GenerationConfig
): Promise<
  | { kind: "started"; data: StartGenerationOk }
  | { kind: "already_running"; status: SummaryStatus }
> {
  try {
    const data = await fetchJson<StartGenerationOk>(
      getSummaryApiUrl(SUMMARY_ROUTES.generate),
      {
        method: "POST",
        headers: { [HTTP_HEADERS.contentType]: CONTENT_TYPES.json },
        body: JSON.stringify({
          [BODY_KEYS.selectedRepos]: config.selectedRepos,
          [BODY_KEYS.since]: config.since,
          [BODY_KEYS.until]: config.until,
          [BODY_KEYS.summaryType]: config.summaryType,
          [BODY_KEYS.year]: config.year,
          [BODY_KEYS.author]: config.author || "",
        }),
      }
    );
    return { kind: "started", data };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const payload = err.payload as StartGenerationConflict;
      if (payload?.status) return { kind: "already_running", status: payload.status };
    }
    throw err;
  }
}

export async function fetchYearlySummary(year: number): Promise<YearlySummaryData> {
  const search = new URLSearchParams({
    [QUERY_KEYS.type]: SUMMARY_TYPES.yearly,
    [QUERY_KEYS.year]: String(year),
  });
  return fetchJson<YearlySummaryData>(
    getSummaryApiUrl(`${SUMMARY_ROUTES.data}?${search}`)
  );
}

export async function fetchDailySummaries(
  year: number,
  repo?: string
): Promise<DailySummaryData[]> {
  const search = new URLSearchParams({
    [QUERY_KEYS.type]: SUMMARY_TYPES.daily,
    [QUERY_KEYS.year]: String(year),
  });
  if (repo) search.set(QUERY_KEYS.repo, repo);
  return fetchJson<DailySummaryData[]>(
    getSummaryApiUrl(`${SUMMARY_ROUTES.data}?${search}`)
  );
}

export async function fetchWeeklySummaries(year: number): Promise<WeeklySummaryData[]> {
  const search = new URLSearchParams({
    [QUERY_KEYS.type]: SUMMARY_TYPES.weekly,
    [QUERY_KEYS.year]: String(year),
  });
  return fetchJson<WeeklySummaryData[]>(
    getSummaryApiUrl(`${SUMMARY_ROUTES.data}?${search}`)
  );
}

export async function fetchMonthlySummaries(year: number): Promise<MonthlySummaryData[]> {
  const search = new URLSearchParams({
    [QUERY_KEYS.type]: SUMMARY_TYPES.monthly,
    [QUERY_KEYS.year]: String(year),
  });
  return fetchJson<MonthlySummaryData[]>(
    getSummaryApiUrl(`${SUMMARY_ROUTES.data}?${search}`)
  );
}

export type RegenerateSummaryRequest = {
  type: SummaryType;
  id: string;
  year: number;
  repo?: string;
  customPrompt?: string;
};

type RegenerateSummaryResponse =
  | { summary: string }
  | { content: string }
  | { summary?: string; content?: string };

export async function regenerateSummary(
  req: RegenerateSummaryRequest
): Promise<string> {
  const data = await fetchJson<RegenerateSummaryResponse>(
    getSummaryApiUrl(SUMMARY_ROUTES.regenerate),
    {
      method: "POST",
      headers: { [HTTP_HEADERS.contentType]: CONTENT_TYPES.json },
      body: JSON.stringify({
        [BODY_KEYS.type]: req.type,
        [BODY_KEYS.id]: req.id,
        [BODY_KEYS.year]: req.year,
        [BODY_KEYS.repo]: req.repo,
        [BODY_KEYS.customPrompt]: req.customPrompt?.trim() || undefined,
      }),
    }
  );

  const updated = (data as { summary?: unknown }).summary ?? (data as { content?: unknown }).content;
  if (typeof updated !== "string" || !updated.trim()) {
    throw new Error("Invalid regeneration response");
  }
  return updated;
}
