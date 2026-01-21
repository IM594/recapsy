import { getSummaryApiUrl } from "@/lib/api";
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
  const data = await fetchJson<{ years?: number[] }>(getSummaryApiUrl("/years"));

  const years = new Set<number>([currentYear]);
  for (const y of data.years || []) {
    if (Number.isFinite(y)) years.add(y);
  }

  return Array.from(years).sort((a, b) => b - a);
}

export async function fetchSummaryStatus(year: number): Promise<SummaryStatus> {
  const search = new URLSearchParams({ year: String(year) });
  return fetchJson<SummaryStatus>(getSummaryApiUrl(`/status?${search}`));
}

export async function resetSummaryStatus(year: number): Promise<SummaryStatus> {
  const data = await fetchJson<{ success: boolean; status: SummaryStatus }>(
    getSummaryApiUrl("/reset"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year }),
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
    const data = await fetchJson<StartGenerationOk>(getSummaryApiUrl("/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...config,
        author: config.author || "",
      }),
    });
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
  const search = new URLSearchParams({ type: "yearly", year: String(year) });
  return fetchJson<YearlySummaryData>(getSummaryApiUrl(`/data?${search}`));
}

export async function fetchDailySummaries(
  year: number,
  repo?: string
): Promise<DailySummaryData[]> {
  const search = new URLSearchParams({ type: "daily", year: String(year) });
  if (repo) search.set("repo", repo);
  return fetchJson<DailySummaryData[]>(getSummaryApiUrl(`/data?${search}`));
}

export async function fetchWeeklySummaries(year: number): Promise<WeeklySummaryData[]> {
  const search = new URLSearchParams({ type: "weekly", year: String(year) });
  return fetchJson<WeeklySummaryData[]>(getSummaryApiUrl(`/data?${search}`));
}

export async function fetchMonthlySummaries(year: number): Promise<MonthlySummaryData[]> {
  const search = new URLSearchParams({ type: "monthly", year: String(year) });
  return fetchJson<MonthlySummaryData[]>(getSummaryApiUrl(`/data?${search}`));
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
    getSummaryApiUrl("/regenerate"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: req.type,
        id: req.id,
        year: req.year,
        repo: req.repo,
        customPrompt: req.customPrompt?.trim() || undefined,
      }),
    }
  );

  const updated = (data as { summary?: unknown }).summary ?? (data as { content?: unknown }).content;
  if (typeof updated !== "string" || !updated.trim()) {
    throw new Error("Invalid regeneration response");
  }
  return updated;
}

