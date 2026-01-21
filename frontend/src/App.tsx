import { useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import { ArrowLeft, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getSummaryApiUrl } from "@/lib/api";
import { toDateString, toMonthString } from "@/lib/date-utils";

import { Dashboard } from "@/components/Dashboard";
import { ResultCard } from "@/components/ResultCard";
import { YearEndContainer } from "@/components/YearEndContainer";
import { YearSwitcher } from "@/components/YearSwitcher";
import { SummaryProvider } from "@/hooks/SummaryContext";
import { SettingsProvider, useSettings } from "@/hooks/useSettings";
import { SummaryType, useSummary } from "@/hooks/useSummary";
import { YearProvider, useYear } from "@/hooks/YearContext";

type ViewState = "dashboard" | "review";

interface GenerationRequest {
  summaryType: SummaryType;
  year: number;
  since: string;
  until: string;
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
      const taskType = status.result.taskType as SummaryType | undefined;
      const since = status.result.since as string | undefined;

      if (!taskType) return;

      // Find the most relevant summary based on the original selection.
      if (taskType === "daily" && status.result.dailySummaries?.length > 0) {
        const targetDate = since ? toDateString(new Date(since)) : undefined;
        if (!targetDate) return;

        const matches = (status.result.dailySummaries as Array<{
          date: string;
          repo: string;
          summary: string;
        }>).filter((d) => d.date === targetDate);

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
          year: status.result.year ?? activeYear,
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
        status.result.weeklySummaries?.length > 0
      ) {
        const targetWeekStart = since ? toDateString(new Date(since)) : undefined;
        if (!targetWeekStart) return;

        const matched = (status.result.weeklySummaries as Array<{
          weekStart: string;
          summary: string;
        }>).find((w) => w.weekStart === targetWeekStart);

        if (!matched?.summary) return;

        setGenerationResult({
          year: status.result.year ?? activeYear,
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
        status.result.monthlySummaries?.length > 0
      ) {
        const targetMonth = since ? toMonthString(new Date(since)) : undefined;
        if (!targetMonth) return;

        const matched = (status.result.monthlySummaries as Array<{
          month: string;
          summary: string;
        }>).find((m) => m.month === targetMonth);

        if (!matched?.summary) return;

        setGenerationResult({
          year: status.result.year ?? activeYear,
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
      // 年度总结的特殊格式
      else if (status.result.result?.content) {
        const content = String(status.result.result.content);
        if (!content) return;

        const y = String(status.result.year ?? activeYear);
        setGenerationResult({
          year: status.result.year ?? activeYear,
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
      // 最后的 fallback
      else if (status.result.content) {
        const content = String(status.result.content);
        if (!content) return;
        setGenerationResult({
          year: status.result.year ?? activeYear,
          title: "Generation Complete",
          summary: content,
          outputPath: "",
          context: {
            type: "yearly",
            id: String(status.result.year ?? activeYear),
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
      {/* macOS 标题栏拖动区域 */}
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
                  const res = await fetch(getSummaryApiUrl("/regenerate"), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      type: generationResult.context.type,
                      id: generationResult.context.id,
                      repo:
                        generationResult.context.type === "daily"
                          ? generationResult.context.repo
                          : undefined,
                      customPrompt: prompt,
                      year: generationResult.year ?? activeYear,
                    }),
                  });
                  if (!res.ok) throw new Error("Failed to regenerate");
                  const data = await res.json();
                  const updated = data.summary ?? data.content;
                  if (!updated) throw new Error("Invalid regeneration response");

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
                  toast.error("Regeneration failed");
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
