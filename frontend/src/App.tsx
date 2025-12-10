import { useState } from "react";
import { InputForm } from "./components/InputForm";
import { ResultView } from "./components/ResultView";
import { Sparkles } from "lucide-react";

function App() {
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (data: {
    userInput: string;
    selectedRepos: string[];
    since?: string;
    until?: string;
  }) => {
    setLoading(true);
    setResult(null);
    console.log(
      "[UI] 提交生成请求",
      `选中仓库: ${data.selectedRepos.length}`,
      `输入长度: ${data.userInput.length}`,
      `since=${data.since || "-"}`,
      `until=${data.until || "-"}`
    );

    try {
      const response = await fetch("http://localhost:3456/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      console.log(
        "[UI] 生成成功",
        `threadId=${result.threadId}, output=${result.outputPath}`
      );
      setResult(result);
    } catch (error) {
      console.error("[UI] 生成失败:", error);
      alert("生成失败，请检查后端服务是否启动");
    } finally {
      setLoading(false);
      console.log("[UI] 生成请求结束");
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
          <h1 className="text-4xl font-extrabold tracking-tight lg:text-5xl text-slate-900">
            智能工作总结助手
          </h1>
          <p className="text-lg text-slate-600 max-w-2xl mx-auto">
            自动整合 Git 提交记录、外部任务数据和您的手动笔记， 使用 AI
            生成专业的每日工作汇报。
          </p>
        </header>

        <main className="space-y-8">
          <InputForm onSubmit={handleSubmit} loading={loading} />

          {result && <ResultView result={result} />}
        </main>

        <footer className="text-center text-sm text-slate-400 pt-8">
          <p>Powered by LangGraph & OpenAI</p>
        </footer>
      </div>
    </div>
  );
}

export default App;
