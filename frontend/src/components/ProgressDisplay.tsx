import { Loader2, CheckCircle2, Circle, AlertCircle, Hash } from "lucide-react";
import type { WorkflowStep } from "@/types/workflow";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

interface ProgressDisplayProps {
  steps: WorkflowStep[];
  currentStep: number;
  threadId?: string;
  configName?: string;
}

// 预定义标准步骤顺序，用于显示"待执行"状态
const EXPECTED_STEPS = [
  { id: "collectGitCommits", label: "📦 收集 Git 提交记录" },
  { id: "collectUserInput", label: "✍️ 处理用户输入" },
  { id: "collectExternalData", label: "🌐 调用外部 API" },
  { id: "aiProcessor", label: "🤖 AI 处理和分析" },
  { id: "exportMarkdown", label: "📝 生成 Markdown 文件" },
];

export function ProgressDisplay({
  steps,
  threadId,
  configName,
}: ProgressDisplayProps) {
  // 合并实际步骤和预期步骤

  const displaySteps = EXPECTED_STEPS.map((expected) => {
    const actual = steps.find((s) => s.step === expected.id);
    return {
      step: expected.id,
      label: expected.label,
      status: actual ? actual.status : "pending",
      message: actual ? actual.message : undefined,
      timestamp: actual ? (actual as any).timestamp : undefined,
    };
  });

  // 处理 steps 中可能存在的非标准步骤
  steps.forEach((s) => {
    if (
      !EXPECTED_STEPS.find((e) => e.id === s.step) &&
      s.step !== "completed"
    ) {
      displaySteps.push({
        step: s.step,
        label: s.step, // Fallback label
        status: s.status,
        message: s.message,
        timestamp: undefined,
      });
    }
  });

  // 计算进度
  const completedCount = displaySteps.filter(
    (s) => s.status === "completed"
  ).length;
  const errorStep = displaySteps.find((s) => s.status === "error");

  // 如果完成了 exportMarkdown 或者收到了 completed 事件 (passed via steps prop usually), 进度 100%
  const isWorkflowCompleted = steps.some(
    (s) => s.step === "completed" && s.status === "completed"
  );
  const progressValue = isWorkflowCompleted
    ? 100
    : Math.max(5, (completedCount / EXPECTED_STEPS.length) * 100);

  return (
    <div className="border rounded-xl p-5 bg-white shadow-sm space-y-5 animate-in fade-in slide-in-from-bottom-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-slate-900">处理进度</h3>
          {threadId && (
            <Badge
              variant="secondary"
              className="font-mono text-[10px] h-5 px-1.5 text-slate-500"
            >
              <Hash className="h-3 w-3 mr-0.5" />
              {threadId.slice(0, 8)}...
            </Badge>
          )}
          {configName && (
            <span className="text-xs text-slate-400 border-l pl-3">
              Config: {configName}
            </span>
          )}
        </div>
        <span className="text-xs font-medium text-slate-500">
          {Math.round(progressValue)}%
        </span>
      </div>

      <Progress
        value={progressValue}
        className={cn(
          "h-2 transition-all duration-500",
          errorStep ? "bg-red-100" : ""
        )}
      />

      <div className="space-y-4 pt-2">
        {displaySteps.map((step, index) => (
          <div key={step.step} className="flex gap-3 relative group">
            {/* 连接线 */}
            {index < displaySteps.length - 1 && (
              <div
                className={cn(
                  "absolute left-[7px] top-6 bottom-[-16px] w-[2px] transition-colors duration-300",
                  step.status === "completed"
                    ? "bg-green-100/50"
                    : "bg-slate-100"
                )}
                aria-hidden="true"
              />
            )}

            {/* 状态图标 */}
            <div className="mt-0.5 relative z-10 w-4 h-4 flex items-center justify-center bg-white">
              {step.status === "completed" && (
                <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0 animate-in zoom-in duration-300" />
              )}
              {step.status === "running" && (
                <Loader2 className="h-4 w-4 text-blue-600 animate-spin flex-shrink-0" />
              )}
              {step.status === "pending" && (
                <Circle className="h-4 w-4 text-slate-200 flex-shrink-0" />
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
                    "text-sm font-medium transition-colors duration-300",
                    step.status === "running"
                      ? "text-blue-600"
                      : step.status === "completed"
                      ? "text-slate-700"
                      : step.status === "error"
                      ? "text-red-700"
                      : "text-slate-400"
                  )}
                >
                  {step.label}
                </p>
                <div className="flex items-center gap-2">
                  {step.status === "running" && (
                    <span className="text-[10px] text-blue-500 animate-pulse font-medium">
                      进行中...
                    </span>
                  )}
                </div>
              </div>

              {/* 错误或详细信息 */}
              {step.message && (
                <div
                  className={cn(
                    "text-xs mt-1 break-words p-2 rounded bg-slate-50 border border-slate-100",
                    step.status === "error"
                      ? "text-red-600 bg-red-50 border-red-100"
                      : "text-muted-foreground"
                  )}
                >
                  {step.message}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
