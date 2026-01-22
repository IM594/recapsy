import { useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import { ArrowLeft, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { buildGenerationResultFromWorkflowResult } from "@/lib/workflow-result";
import { regenerateSummary } from "@/services/summary";
import { COPY } from "@/constants/copy";
import { logError } from "@/lib/logger";
import { SUMMARY_TYPES, WORKFLOW_PHASES } from "@recaply/shared";

import { Dashboard } from "@/components/Dashboard";
import { ResultCard } from "@/components/ResultCard";
import { YearEndContainer } from "@/components/YearEndContainer";
import { YearSwitcher } from "@/components/YearSwitcher";
import { SummaryProvider } from "@/hooks/SummaryContext";
import { SettingsProvider, useSettings } from "@/hooks/useSettings";
import { useSummary } from "@/hooks/useSummary";
import { YearProvider, useYear } from "@/hooks/YearContext";
import type { GenerationConfig } from "@/types/summary";
import type { GenerationResultState } from "@/types/generation";

type ViewState = "dashboard" | "review";

type GenerationRequest = Pick<
  GenerationConfig,
  "summaryType" | "year" | "since" | "until"
>;

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
    if (
      !status.isRunning &&
      status.phase === WORKFLOW_PHASES.complete &&
      status.result
    ) {
      const next = buildGenerationResultFromWorkflowResult(status.result, activeYear);
      if (next) {
        setGenerationResult(next);
      } else {
        toast.info(COPY.toasts.noCommitsFound);
      }
    }
  }, [activeYear, status.phase, status.isRunning, status.result]);

  const dailyRepoOptions = useMemo(() => {
    return generationResult?.context.type === SUMMARY_TYPES.daily
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
              {COPY.appName}
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
                {COPY.common.buttons.backToDashboard}
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
          <DialogTitle className="sr-only">
            {COPY.app.generatedSummaryDialogTitle}
          </DialogTitle>
          {generationResult && (
            <ResultCard
              title={generationResult.title}
              summary={generationResult.summary}
              outputPath={generationResult.outputPath}
              repo={
                generationResult.context.type === SUMMARY_TYPES.daily
                  ? generationResult.context.repo
                  : undefined
              }
              repoOptions={dailyRepoOptions}
              onRepoChange={(repo) => {
                setGenerationResult((prev) => {
                  if (!prev || prev.context.type !== SUMMARY_TYPES.daily) return prev;
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
                      generationResult.context.type === SUMMARY_TYPES.daily
                        ? generationResult.context.repo
                        : undefined,
                    customPrompt: prompt,
                    year: generationResult.year ?? activeYear,
                  });

                  // Update local state with new summary
                  setGenerationResult((prev) => {
                    if (!prev) return prev;
                    if (prev.context.type === SUMMARY_TYPES.daily && prev.context.repo) {
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
                  toast.success(COPY.toasts.regenerationSuccessful);
                } catch (e) {
                  logError("app.regenerate", e, {
                    type: generationResult.context.type,
                    id: generationResult.context.id,
                    year: generationResult.year ?? activeYear,
                  });
                  const message =
                    e instanceof Error ? e.message : COPY.toasts.regenerationFailedFallback;
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
