import { useState } from "react";
import { InputForm } from "./components/InputForm";
import { ResultCard } from "./components/ResultCard";
import { YearEndContainer } from "./components/YearEndContainer";
import { Sparkles, Loader2 } from "lucide-react";
import { Toaster, toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function App() {
  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="text-center space-y-2">
          <div className="inline-flex items-center justify-center p-3 bg-white rounded-full shadow-sm mb-4">
            <Sparkles className="h-6 w-6 text-primary mr-2" />
            <span className="font-bold text-xl tracking-tight">
              Daily Work Summarizer
            </span>
          </div>
        </header>

        <main className="space-y-8">
          <Tabs defaultValue="review" className="w-full">
            <div className="flex justify-center mb-8">
              <TabsList className="grid w-full max-w-md grid-cols-2">
                <TabsTrigger value="generator">Daily/Weekly Tools</TabsTrigger>
                <TabsTrigger value="review">Year-End Review</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="generator" className="space-y-8">
              <SummaryGenerator />
            </TabsContent>

            <TabsContent value="review">
              <YearEndContainer />
            </TabsContent>
          </Tabs>
        </main>
      </div>
      <Toaster />
    </div>
  );
}

// Wrapper for the existing InputForm + Result part to keep App clean
function SummaryGenerator() {
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
    <div className="max-w-3xl mx-auto space-y-8">
      <InputForm onSubmit={handleSubmit} loading={loading} />
      {loading && (
        <div className="flex items-center justify-center p-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span className="ml-2 text-primary font-medium">生成中...</span>
        </div>
      )}
      {result && (
        <ResultCard summary={result.summary} outputPath={result.outputPath} />
      )}
    </div>
  );
}

export default App;
