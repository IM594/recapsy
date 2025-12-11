import { Loader2, CheckCircle2, Circle, AlertCircle } from "lucide-react";
import type { WorkflowStep } from "@/types/workflow";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

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

  // 计算总体进度
  const totalSteps = 5; // 预估总步骤数
  const completedSteps = steps.filter((s) => s.status === "completed").length;
  // 简单的进度计算逻辑
  const progressValue = Math.min((completedSteps / totalSteps) * 100, 100);

  return (
    <div className="border rounded-xl p-5 bg-white shadow-sm space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">处理进度</h3>
        <span className="text-xs font-medium text-slate-500">
          {Math.round(progressValue)}%
        </span>
      </div>

      <Progress value={progressValue} className="h-2" />

      <div className="space-y-4 pt-2">
        {steps.map((step, index) => (
          <div key={index} className="flex gap-3 relative">
            {/* 连接线 (除了最后一个) */}
            {index < steps.length - 1 && (
              <div
                className="absolute left-[7px] top-6 bottom-[-16px] w-[2px] bg-slate-100"
                aria-hidden="true"
              />
            )}

            {/* 状态图标 */}
            <div className="mt-0.5 relative z-10 w-4 h-4 flex items-center justify-center bg-white">
              {step.status === "completed" && (
                <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
              )}
              {step.status === "running" && (
                <Loader2 className="h-4 w-4 text-blue-600 animate-spin flex-shrink-0" />
              )}
              {step.status === "pending" && (
                <Circle className="h-4 w-4 text-slate-300 flex-shrink-0" />
              )}
              {step.status === "error" && (
                <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0" />
              )}
            </div>

            {/* 步骤信息 */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <p
                  className={cn(
                    "text-sm font-medium transition-colors",
                    step.status === "running"
                      ? "text-blue-600"
                      : step.status === "completed"
                      ? "text-slate-700"
                      : step.status === "error"
                      ? "text-red-700"
                      : "text-slate-400"
                  )}
                >
                  {stepNames[step.step] || step.step}
                </p>
                <span className="text-xs text-slate-400 font-mono">
                  {step.status === "running"
                    ? "进行中..."
                    : step.status === "completed"
                    ? "已完成"
                    : step.status === "error"
                    ? "失败"
                    : ""}
                </span>
              </div>

              {step.message && (
                <p className="text-xs text-muted-foreground mt-1 break-words">
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
