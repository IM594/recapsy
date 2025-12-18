import { useState, useEffect } from "react";
import { ResultCard } from "./components/ResultCard";
import { YearEndContainer } from "./components/YearEndContainer";
import { Dashboard } from "./components/Dashboard";
import { Sparkles, ArrowLeft } from "lucide-react";
import { Toaster, toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SettingsProvider, useSettings } from "./hooks/useSettings";
import { SummaryProvider } from "./hooks/SummaryContext";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useSummary } from "./hooks/useSummary";
import { getDateRangeForType } from "./lib/date-utils";

type ViewState = "dashboard" | "review";

function AppContent() {
  const [view, setView] = useState<ViewState>("dashboard");
  const [yearEndMode, setYearEndMode] = useState<"view" | "regenerate">("view");

  const [generationResult, setGenerationResult] = useState<any>(null);
  const { selectedRepos, author } = useSettings();
  const { status, startGeneration } = useSummary();



  // Watch for completion
  useEffect(() => {
    if (!status.isRunning && status.phase === "complete" && status.result) {
      console.log("Status result:", status.result);
      let summaryContent = "";
      let contextId = "";
      let contextRepo = "default";

      const taskType = status.result.taskType;
      const since = status.result.since;

      // 根据请求的 since 时间，找到对应的摘要
      if (taskType === "daily" && status.result.dailySummaries?.length > 0) {
        // 从 since 提取本地日期 YYYY-MM-DD
        const targetDate = new Date(since).toLocaleDateString("en-CA");
        const matched = status.result.dailySummaries.find(
          (d: { date: string; repo: string }) => d.date === targetDate
        );
        if (matched) {
          summaryContent = matched.summary;
          contextId = matched.date;
          contextRepo = matched.repo;
        }
      } else if (
        taskType === "weekly" &&
        status.result.weeklySummaries?.length > 0
      ) {
        // 从 since 提取本地日期作为周起始
        const targetWeekStart = new Date(since).toLocaleDateString("en-CA");
        const matched = status.result.weeklySummaries.find(
          (w: { weekStart: string }) => w.weekStart === targetWeekStart
        );
        if (matched) {
          summaryContent = matched.summary;
          contextId = matched.weekStart;
        }
      } else if (
        taskType === "monthly" &&
        status.result.monthlySummaries?.length > 0
      ) {
        // 从 since 提取本地月份 YYYY-MM
        const targetMonth = new Date(since).toLocaleDateString("en-CA").substring(0, 7);
        const matched = status.result.monthlySummaries.find(
          (m: { month: string }) => m.month === targetMonth
        );
        if (matched) {
          summaryContent = matched.summary;
          contextId = matched.month;
        }
      }
      // 年度总结的特殊格式
      else if (status.result.result?.content) {
        summaryContent = status.result.result.content;
        contextId = String(status.result.year);
      }
      // 最后的 fallback
      else if (status.result.content) {
        summaryContent = status.result.content;
      }

      if (summaryContent) {
        setGenerationResult({
          summary: summaryContent,
          outputPath: "",
          context: {
            type: taskType,
            id: contextId,
            repo: contextRepo,
          },
        });
      } else {
        // No data generated - show a friendly toast
        toast.info(
          `${
            taskType === "daily"
              ? "今天"
              : taskType === "weekly"
              ? "本周"
              : "该时间段"
          }没有提交记录，无法生成总结`
        );
      }
    }
  }, [status.phase, status.isRunning, status.result]);

  const handleGenerate = async (
    type: "daily" | "weekly" | "monthly" | "yearly"
  ) => {
    setGenerationResult(null);

    const { start, end } = getDateRangeForType(type);

    startGeneration({
      selectedRepos,
      since: start.toISOString(),
      until: end.toISOString(),
      summaryType: type,
      author,
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="flex items-center justify-between">
          <div
            className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
            onClick={() => setView("dashboard")}
          >
            <div className="bg-slate-900 text-white p-2 rounded-lg">
              <Sparkles className="h-5 w-5" />
            </div>
            <span className="font-bold text-xl tracking-tight text-slate-900">
              Recaply
            </span>
          </div>

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
        </header>

        <main className="min-h-[600px] relative">
          {view === "dashboard" && (
            <Dashboard
              onGenerate={handleGenerate}
              onViewYearReview={(mode) => {
                setYearEndMode(mode);
                setView("review");
              }}
              isGenerating={status.isRunning}
            />
          )}

          {view === "review" && (
            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
              <YearEndContainer forcedMode={yearEndMode} />
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
          <DialogTitle className="sr-only">生成结果</DialogTitle>
          {generationResult && (
            <ResultCard
              summary={generationResult.summary}
              outputPath={generationResult.outputPath}
              onRegenerate={async (prompt) => {
                try {
                  const res = await fetch(
                    "http://localhost:3456/api/summary/regenerate",
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        type: generationResult.context?.type || "daily",
                        id: generationResult.context?.id,
                        repo: generationResult.context?.repo,
                        customPrompt: prompt,
                      }),
                    }
                  );
                  if (!res.ok) throw new Error("Failed to regenerate");
                  const data = await res.json();

                  // Update local state with new summary
                  setGenerationResult((prev: any) => ({
                    ...prev,
                    summary: data.summary,
                  }));
                  toast.success("重新生成成功！");
                } catch (e) {
                  console.error(e);
                  toast.error("重新生成失败");
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
      <SummaryProvider>
        <AppContent />
      </SummaryProvider>
    </SettingsProvider>
  );
}

export default App;
