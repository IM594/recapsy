import { Loader2, CheckCircle2, Circle } from "lucide-react";
import type { WorkflowStep } from "@/types/workflow";

interface ProgressDisplayProps {
  steps: WorkflowStep[];
  currentStep: number;
}

// 步骤名称映射
const stepNames: Record<string, string> = {
  collectGitCommits: "📦 收集 Git 提交记录",
  collectUserInput: "✍️ 接收用户输入",
  collectExternalData: "🌐 调用外部 API",
  aiProcessor: "🤖 AI 处理和分析",
  exportMarkdown: "📝 生成 Markdown 文件",
  completed: "✅ 完成",
};

export function ProgressDisplay({ steps }: ProgressDisplayProps) {
  if (steps.length === 0) return null;

  return (
    <div className="border rounded-md p-4 bg-slate-50 space-y-3">
      <h3 className="text-sm font-medium">处理进度</h3>
      <div className="space-y-2">
        {steps.map((step, index) => (
          <div key={index} className="flex items-center gap-3">
            {/* 状态图标 */}
            {step.status === "completed" && (
              <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
            )}
            {step.status === "running" && (
              <Loader2 className="h-4 w-4 text-blue-600 animate-spin flex-shrink-0" />
            )}
            {step.status === "pending" && (
              <Circle className="h-4 w-4 text-gray-400 flex-shrink-0" />
            )}
            {step.status === "error" && (
              <Circle className="h-4 w-4 text-red-600 flex-shrink-0" />
            )}

            {/* 步骤信息 */}
            <div className="flex-1 min-w-0">
              <p
                className={`text-sm ${
                  step.status === "running"
                    ? "font-medium text-blue-600"
                    : step.status === "completed"
                    ? "text-gray-600"
                    : "text-gray-400"
                }`}
              >
                {stepNames[step.step] || step.step}
              </p>
              {step.message && (
                <p className="text-xs text-muted-foreground truncate">
                  {step.message}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
