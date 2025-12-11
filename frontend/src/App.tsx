import { useState } from "react";
import { InputForm } from "./components/InputForm";
import { ResultCard } from "./components/ResultCard";
import { ProgressDisplay } from "./components/ProgressDisplay";
import type { WorkflowStep } from "./types/workflow";
import { Sparkles } from "lucide-react";
import { Toaster, toast } from "sonner";

function App() {
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState<WorkflowStep[]>([]);

  // 运行元数据,用于 UI 展示上下文
  const [runMeta, setRunMeta] = useState<{
    threadId?: string;
    configName?: string;
    timeRange?: { since: string; until: string };
    repoCount?: number;
  } | null>(null);

  const handleSubmit = async (data: {
    userInput: string;
    selectedRepos: string[];
    since?: string;
    until?: string;
    summaryType?: "today" | "week" | "month" | "custom";
    configName?: string;
  }) => {
    setLoading(true);
    setResult(null);
    setSteps([]);

    // 初始化元数据
    setRunMeta({
      configName: data.configName,
      timeRange: {
        since: data.since || "Multiple",
        until: data.until || "Now",
      },
      repoCount: data.selectedRepos.length,
    });

    try {
      // 1. 启动工作流
      const payload = {
        userInput: data.userInput,
        selectedRepos: data.selectedRepos,
        since: data.since,
        until: data.until,
        summaryType: data.summaryType,
      };

      const response = await fetch("http://localhost:3456/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error("启动工作流失败");
      }

      const { threadId } = await response.json();
      console.log("[App] 工作流已启动, threadId:", threadId);

      setRunMeta((prev) => ({ ...prev, threadId }));

      // 2. 连接 SSE
      const eventSource = new EventSource(
        `http://localhost:3456/api/progress/${threadId}`
      );

      eventSource.onmessage = (event) => {
        const progressEvent: WorkflowStep = JSON.parse(event.data);
        console.log("[App] 收到进度:", progressEvent);

        setSteps((prev) => {
          const existingIndex = prev.findIndex(
            (s) => s.step === progressEvent.step
          );
          if (existingIndex >= 0) {
            const newSteps = [...prev];
            newSteps[existingIndex] = progressEvent;
            return newSteps;
          } else {
            return [...prev, progressEvent];
          }
        });

        if (progressEvent.step === "completed") {
          if (progressEvent.status === "completed") {
            const summaryData = progressEvent.summary;
            setResult({
              summary: summaryData,
              outputPath: progressEvent.outputPath,
            });
            toast.success("总结生成完成!");
          } else if (progressEvent.status === "error") {
            toast.error(`工作流失败: ${progressEvent.message}`);
          }
          eventSource.close();
          setLoading(false);
        }
      };

      eventSource.onerror = (error) => {
        console.error("[App] SSE 错误:", error);
        eventSource.close();
        setLoading(false);
      };
    } catch (error: any) {
      console.error("[App] 提交失败:", error);
      toast.error(`提交失败: ${error.message}`);
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        <header className="text-center space-y-2">
          <div className="inline-flex items-center justify-center p-3 bg-white rounded-full shadow-sm mb-4">
            <Sparkles className="h-6 w-6 text-primary mr-2" />
            <span className="font-bold text-xl tracking-tight">
              Daily Work Summarizer
            </span>
          </div>
        </header>

        <main className="space-y-8">
          <InputForm
            onSubmit={handleSubmit}
            loading={loading}
            workflowSteps={steps}
          />

          {/* Progress Display moved out of InputForm */}
          {steps.length > 0 && (
            <ProgressDisplay
              steps={steps}
              currentStep={0}
              threadId={runMeta?.threadId}
              configName={runMeta?.configName}
            />
          )}

          {result && (
            <ResultCard
              summary={result.summary}
              outputPath={result.outputPath}
              threadId={runMeta?.threadId}
              timeRange={runMeta?.timeRange}
              configName={runMeta?.configName}
              repoCount={runMeta?.repoCount}
            />
          )}
        </main>

        <footer className="text-center text-sm text-slate-400 pt-8">
          <p>Powered by LangGraph</p>
        </footer>
      </div>
      <Toaster />
    </div>
  );
}

export default App;
