import { useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import { ArrowLeft, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { toDateString, toMonthString } from "@/lib/date-utils";
import { regenerateSummary } from "@/services/summary";

import { Dashboard } from "@/components/Dashboard";
import { ResultCard } from "@/components/ResultCard";
import { YearEndContainer } from "@/components/YearEndContainer";
import { YearSwitcher } from "@/components/YearSwitcher";
import { SummaryProvider } from "@/hooks/SummaryContext";
import { SettingsProvider, useSettings } from "@/hooks/useSettings";
import { useSummary } from "@/hooks/useSummary";
import { YearProvider, useYear } from "@/hooks/YearContext";
import type { SummaryType } from "@/types/summary";

type ViewState = "dashboard" | "review";

interface GenerationRequest {
  summaryType: SummaryType;
  year: number;
  since: string;
  until: string;
}

type SummaryWorkflowResult = {
  taskType?: SummaryType;
  since?: string;
  year?: number;
  dailySummaries?: Array<{ date: string; repo: string; summary: string }>;
  weeklySummaries?: Array<{ weekStart: string; summary: string }>;
  monthlySummaries?: Array<{ month: string; summary: string }>;
  content?: string;
  result?: { content?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type GenerationContext =
  | {
      type: "daily";
      id: string; // YYYY-MM-DD
      repo: string;
      repoOptions?: string[];
      summariesByRepo?: Record<string, string>;
    }
  | {
      type: "weekly";
      id: string; // weekStart YYYY-MM-DD
    }
  | {
      type: "monthly";
      id: string; // YYYY-MM
    }
  | {
      type: "yearly";
      id: string; // YYYY
    };

interface GenerationResultState {
  year: number;
  title: string;
  summary: string;
  outputPath: string;
  context: GenerationContext;
}

function AppContent() {
  const [view, setView] = useState<ViewState>("dashboard");
  const [yearEndMode, setYearEndMode] = useState<"view" | "regenerate">("view");

  const [generationResult, setGenerationResult] =
    useState<GenerationResultState | null>(null);
  const { selectedRepos, author } = useSettings();
  const { activeYear } = useYear();
  const { status, startGeneration } = useSummary();

  // Watch for completion
  useEffect(() => {
    if (!status.isRunning && status.phase === "complete" && status.result) {
      if (!isRecord(status.result)) return;
      const result = status.result as SummaryWorkflowResult;
      const taskType = result.taskType;
      const since = result.since;
      const dailySummaries = result.dailySummaries;
      const weeklySummaries = result.weeklySummaries;
      const monthlySummaries = result.monthlySummaries;

      if (!taskType) return;

      // Find the most relevant summary based on the original selection.
      if (taskType === "daily" && dailySummaries && dailySummaries.length > 0) {
        const targetDate = since ? toDateString(new Date(since)) : undefined;
        if (!targetDate) return;

        const matches = dailySummaries.filter((d) => d.date === targetDate);

        if (matches.length === 0) return;

        const summariesByRepo = Object.fromEntries(
          matches.map((m) => [m.repo, m.summary])
        );
        const repoOptions = matches
          .map((m) => m.repo)
          .slice()
          .sort((a, b) => a.localeCompare(b));

        const defaultRepo = repoOptions[0];
        const defaultSummary = summariesByRepo[defaultRepo] ?? "";

        if (!defaultSummary) return;

        setGenerationResult({
          year: result.year ?? activeYear,
          title: `Daily Brief (${targetDate})`,
          summary: defaultSummary,
          outputPath: "",
          context: {
            type: "daily",
            id: targetDate,
            repo: defaultRepo,
            repoOptions,
            summariesByRepo,
          },
        });
        return;
      } else if (
        taskType === "weekly" &&
        weeklySummaries &&
        weeklySummaries.length > 0
      ) {
        const targetWeekStart = since ? toDateString(new Date(since)) : undefined;
        if (!targetWeekStart) return;

        const matched = weeklySummaries.find(
          (w) => w.weekStart === targetWeekStart
        );

        if (!matched?.summary) return;

        setGenerationResult({
          year: result.year ?? activeYear,
          title: `Weekly Report (${targetWeekStart})`,
          summary: matched.summary,
          outputPath: "",
          context: {
            type: "weekly",
            id: matched.weekStart,
          },
        });
        return;
      } else if (
        taskType === "monthly" &&
        monthlySummaries &&
        monthlySummaries.length > 0
      ) {
        const targetMonth = since ? toMonthString(new Date(since)) : undefined;
        if (!targetMonth) return;

        const matched = monthlySummaries.find(
          (m) => m.month === targetMonth
        );

        if (!matched?.summary) return;

        setGenerationResult({
          year: result.year ?? activeYear,
          title: `Monthly Summary (${targetMonth})`,
          summary: matched.summary,
          outputPath: "",
          context: {
            type: "monthly",
            id: matched.month,
          },
        });
        return;
      }
      // Year-end workflow has a different nested payload shape.
      else if (result.result?.content) {
        const content = String(result.result.content);
        if (!content) return;

        const y = String(result.year ?? activeYear);
        setGenerationResult({
          year: result.year ?? activeYear,
          title: `Yearly Review (${y})`,
          summary: content,
          outputPath: "",
          context: {
            type: "yearly",
            id: y,
          },
        });
        return;
      }
      // Final fallback: some workflows return `{ content }` directly.
      else if (result.content) {
        const content = String(result.content);
        if (!content) return;
        setGenerationResult({
          year: result.year ?? activeYear,
          title: "Generation Complete",
          summary: content,
          outputPath: "",
          context: {
            type: "yearly",
            id: String(result.year ?? activeYear),
          },
        });
        return;
      }

      toast.info("No commits found for the selected period.");
    }
  }, [activeYear, status.phase, status.isRunning, status.result]);

  const dailyRepoOptions = useMemo(() => {
    return generationResult?.context.type === "daily"
      ? generationResult.context.repoOptions
      : undefined;
  }, [generationResult]);

  const handleGenerate = async (req: GenerationRequest) => {
    setGenerationResult(null);

    await startGeneration({
      selectedRepos,
      since: req.since,
      until: req.until,
      summaryType: req.summaryType,
      author,
      year: req.year,
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      {/* macOS titlebar drag region */}
      <div className="h-7 w-full" style={{ WebkitAppRegion: "drag" }} />

      <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-8">
        <header className="flex items-center justify-between">
          <div
            className="flex items-center gap-3 cursor-pointer hover:opacity-80 transition-opacity"
            onClick={() => setView("dashboard")}
          >
            <div className="bg-slate-900 text-white p-2 rounded-lg">
              <Sparkles className="h-5 w-5" />
            </div>
            <span className="font-bold text-xl tracking-tight text-slate-900">
              Recaply
            </span>
          </div>

          <div className="flex items-center gap-2">
            <YearSwitcher />
            {view !== "dashboard" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setView("dashboard")}
                className="text-slate-500 hover:text-slate-900"
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Dashboard
              </Button>
            )}
          </div>
        </header>

        <main className="min-h-[600px] relative">
          {view === "dashboard" && (
            <Dashboard
              onGenerate={handleGenerate}
              onViewYearReview={(mode) => {
                setYearEndMode(mode);
                setView("review");
              }}
              year={activeYear}
              isGenerating={status.isRunning}
            />
          )}

          {view === "review" && (
            <div className="animate-in fade-in duration-300">
              <YearEndContainer initialYear={activeYear} forcedMode={yearEndMode} />
            </div>
          )}
        </main>
      </div>

      <Dialog
        open={!!generationResult}
        onOpenChange={(open) => !open && setGenerationResult(null)}
      >
        <DialogContent
          className="max-w-4xl max-h-[90vh] p-0 border-0 bg-transparent shadow-none [&>button]:bg-white/50 [&>button]:hover:bg-white [&>button]:text-slate-500 [&>button]:top-3 [&>button]:right-3"
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">Generated Summary</DialogTitle>
          {generationResult && (
            <ResultCard
              title={generationResult.title}
              summary={generationResult.summary}
              outputPath={generationResult.outputPath}
              repo={
                generationResult.context.type === "daily"
                  ? generationResult.context.repo
                  : undefined
              }
              repoOptions={dailyRepoOptions}
              onRepoChange={(repo) => {
                setGenerationResult((prev) => {
                  if (!prev || prev.context.type !== "daily") return prev;
                  const summary = prev.context.summariesByRepo?.[repo];
                  if (!summary) return prev;
                  return {
                    ...prev,
                    summary,
                    context: { ...prev.context, repo },
                  };
                });
              }}
              onRegenerate={async (prompt) => {
                try {
                  const updated = await regenerateSummary({
                    type: generationResult.context.type,
                    id: generationResult.context.id,
                    repo:
                      generationResult.context.type === "daily"
                        ? generationResult.context.repo
                        : undefined,
                    customPrompt: prompt,
                    year: generationResult.year ?? activeYear,
                  });

                  // Update local state with new summary
                  setGenerationResult((prev) => {
                    if (!prev) return prev;
                    if (prev.context.type === "daily" && prev.context.repo) {
                      const nextByRepo = {
                        ...(prev.context.summariesByRepo ?? {}),
                        [prev.context.repo]: updated,
                      };
                      return {
                        ...prev,
                        summary: updated,
                        context: {
                          ...prev.context,
                          summariesByRepo: nextByRepo,
                        },
                      };
                    }

                    return {
                      ...prev,
                      summary: updated,
                    };
                  });
                  toast.success("Regeneration successful!");
                } catch (e) {
                  console.error(e);
                  const message =
                    e instanceof Error ? e.message : "Regeneration failed";
                  toast.error(message);
                }
              }}
              isRegenerating={false} // Would need state for true async loading if we want spinner to persist longer than await
            />
          )}
        </DialogContent>
      </Dialog>

      <Toaster />
    </div>
  );
}

function App() {
  return (
    <SettingsProvider>
      <YearProvider>
        <YearAwareSummaryProvider>
          <AppContent />
        </YearAwareSummaryProvider>
      </YearProvider>
    </SettingsProvider>
  );
}

export default App;

function YearAwareSummaryProvider({ children }: { children: React.ReactNode }) {
  const { activeYear } = useYear();
  return <SummaryProvider year={activeYear}>{children}</SummaryProvider>;
}
