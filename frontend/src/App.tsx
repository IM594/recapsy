import { useState } from "react";
import { InputForm } from "./components/InputForm";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import type { WorkflowStep } from "./types/workflow";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Sparkles, CheckCircle2, FileText, Copy, Download } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Toaster, toast } from "sonner";

function App() {
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState<WorkflowStep[]>([]);

  const handleSubmit = async (data: {
    userInput: string;
    selectedRepos: string[];
    since?: string;
    until?: string;
    summaryType?: "today" | "week" | "month" | "custom";
  }) => {
    setLoading(true);
    setResult(null);
    setSteps([]);

    try {
      // 1. 启动工作流,获取 threadId
      const response = await fetch("http://localhost:3456/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        throw new Error("启动工作流失败");
      }

      const { threadId } = await response.json();
      console.log("[App] 工作流已启动, threadId:", threadId);

      // 2. 连接 SSE 接收进度
      const eventSource = new EventSource(
        `http://localhost:3456/api/progress/${threadId}`
      );

      eventSource.onmessage = (event) => {
        const progressEvent: WorkflowStep = JSON.parse(event.data);
        console.log("[App] 收到进度:", progressEvent);

        setSteps((prev) => {
          // 更新或添加步骤
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

        // 后端会在工作流结束时发送 step="completed" 的事件
        // 前端只需要被动响应,不做任何判断
        if (progressEvent.step === "completed") {
          // 如果是成功完成,保存结果
          if (progressEvent.status === "completed") {
            const summaryData = progressEvent.summary;

            setResult({
              summary: summaryData,
              outputPath: progressEvent.outputPath,
            });
          } else if (progressEvent.status === "error") {
            // 如果是失败完成,显示错误
            toast.error(`工作流失败: ${progressEvent.message}`);
          }

          // 关闭连接
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

          {result && (
            <Card className="overflow-hidden border-slate-200 shadow-sm">
              <CardHeader className="bg-white border-b border-slate-100 pb-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-slate-800">
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                    生成完成
                  </CardTitle>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(result.summary);
                        toast.success("内容已复制");
                      }}
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      复制
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const blob = new Blob([result.summary], {
                          type: "text/markdown",
                        });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "summary.md";
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      <Download className="h-4 w-4 mr-2" />
                      下载
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0 bg-white">
                <ScrollArea className="h-[500px] w-full p-6">
                  <article className="prose prose-slate max-w-none prose-p:leading-relaxed prose-headings:font-semibold prose-a:text-primary hover:prose-a:text-primary/80">
                    <ReactMarkdown>{result.summary}</ReactMarkdown>
                  </article>
                </ScrollArea>

                <div className="border-t border-slate-50 p-4 bg-slate-50/50 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
                    <FileText className="h-3 w-3 flex-shrink-0" />
                    <span
                      className="truncate max-w-[300px]"
                      title={result.outputPath}
                    >
                      {result.outputPath}
                    </span>
                  </div>
                  <Badge
                    variant="outline"
                    className="text-xs bg-white text-slate-500 font-normal"
                  >
                    Markdown Genererated
                  </Badge>
                </div>
              </CardContent>
            </Card>
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
