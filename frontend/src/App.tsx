import { useState } from "react";
import { InputForm } from "./components/InputForm";
import { ResultCard } from "./components/ResultCard";
import { DevToolPanel } from "./components/DevToolPanel";
import { Sparkles, Loader2 } from "lucide-react";
import { Toaster, toast } from "sonner";

function App() {
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (data: {
    selectedRepos: string[];
    since?: string;
    until?: string;
    summaryType?: "today" | "week" | "month";
  }) => {
    setLoading(true);
    setResult(null);

    try {
      const response = await fetch("http://localhost:3456/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        throw new Error("工作流执行失败");
      }

      const resData = await response.json();

      if (resData.status === "completed") {
        setResult({
          summary: resData.summary,
          outputPath: resData.outputPath,
        });
        toast.success("总结生成完成!");
      } else {
        toast.error("生成失败");
      }
    } catch (error: any) {
      console.error("[App] 提交失败:", error);
      toast.error(`提交失败: ${error.message}`);
    } finally {
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
          <InputForm onSubmit={handleSubmit} loading={loading} />

          {/* DevTool Panel - Collapsible */}
          <DevToolPanel />

          {loading && (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="ml-2 text-slate-500">正在生成总结...</span>
            </div>
          )}

          {result && (
            <ResultCard
              summary={result.summary}
              outputPath={result.outputPath}
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
