import {
  Loader2,
  CheckCircle2,
  Circle,
  AlertCircle,
  Hash,
  GitGraph,
  PenTool,
  Globe,
  Bot,
  FileText,
  Cpu,
  Layers,
  Search,
  BookOpen,
} from "lucide-react";
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

// 步骤元数据映射：提供友好的名称和图标
const STEP_METADATA: Record<string, { label: string; icon: any }> = {
  // Common
  git_collector: { label: "收集 Git 提交记录", icon: GitGraph },
  user_input: { label: "处理用户输入", icon: PenTool },
  external_api: { label: "调用外部 API", icon: Globe },

  // Legacy
  aiProcessor: { label: "AI 智能分析", icon: Bot },

  // Deep Analysis
  diff_collector: { label: "获取代码变更 (Diff)", icon: Search },
  diffPreprocessor: { label: "Diff 预处理与摘要", icon: Layers },
  dataBarrier: { label: "数据同步屏障", icon: Circle }, // Maybe different icon
  technicalAnalyst: { label: "技术深度分析", icon: Cpu },
  contextAnalyst: { label: "业务上下文分析", icon: BookOpen },
  synthesizer: { label: "生成最终报告", icon: FileText },

  // Export
  exportMarkdown: { label: "导出 Markdown 文件", icon: FileText },
  completed: { label: "流程结束", icon: CheckCircle2 },
};

export function ProgressDisplay({
  steps,
  threadId,
  configName,
}: ProgressDisplayProps) {
  // 过滤掉 'completed' 事件步骤，因为它只是一个信号，或者把它作为最后一步展示也可以
  // 这里我们选择把它作为最后一步展示，如果它包含 summary 信息的话
  const displaySteps = steps.filter(
    (s) => s.step !== "completed" || s.status === "error"
  );

  // 计算进度
  const completedCount = displaySteps.filter(
    (s) => s.status === "completed"
  ).length;
  const isWorkflowCompleted = steps.some(
    (s) => s.step === "completed" && s.status === "completed"
  );

  // 动态计算进度条:
  // 如果流程结束，直接 100%
  // 否则，基于已开始的步骤数量大致估算。
  // 由于我们不知道总步骤数（动态的），我们可以假设一个最小值或基于 current index
  // 更好的方式可能是只显示 "处理中" 动画，或者仅仅显示已完成步骤的比例（假设总数至少为 5）
  const estimatedTotal = Math.max(displaySteps.length + 2, 5);
  const progressValue = isWorkflowCompleted
    ? 100
    : Math.max(5, (completedCount / estimatedTotal) * 100);

  const errorStep = displaySteps.find((s) => s.status === "error");

  return (
    <div className="border rounded-xl p-5 bg-white shadow-sm space-y-5 animate-in fade-in slide-in-from-bottom-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-slate-900">
            执行流 (Execution Flow)
          </h3>
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
          {isWorkflowCompleted ? "完成" : "进行中"}
        </span>
      </div>

      <Progress
        value={progressValue}
        className={cn(
          "h-1 transition-all duration-500",
          errorStep ? "bg-red-100" : ""
        )}
      />

      <div className="space-y-0 pt-2 relative">
        {/* 垂直连接线背景 - 贯穿整个列表 */}
        <div
          className="absolute left-[15px] top-4 bottom-4 w-[2px] bg-slate-100 z-0"
          aria-hidden="true"
        />

        {displaySteps.map((step, index) => {
          const meta = STEP_METADATA[step.step] || {
            label: step.step,
            icon: Circle,
          };
          const Icon = meta.icon;

          return (
            <div
              key={step.step}
              className="flex gap-4 relative group pb-6 last:pb-0"
            >
              {/* 状态图标 */}
              <div
                className={cn(
                  "relative z-10 w-8 h-8 rounded-full flex items-center justify-center border-2 transition-colors duration-300",
                  step.status === "completed"
                    ? "bg-white border-green-500 text-green-600"
                    : step.status === "running"
                    ? "bg-white border-blue-500 text-blue-600"
                    : step.status === "error"
                    ? "bg-white border-red-500 text-red-600"
                    : "bg-white border-slate-200 text-slate-300"
                )}
              >
                {step.status === "running" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Icon className="h-4 w-4" />
                )}
              </div>

              {/* 步骤信息 */}
              <div className="flex-1 min-w-0 pt-1">
                <div className="flex items-center justify-between mb-1">
                  <p
                    className={cn(
                      "text-sm font-medium transition-colors duration-300",
                      step.status === "running"
                        ? "text-blue-700"
                        : step.status === "completed"
                        ? "text-slate-700"
                        : step.status === "error"
                        ? "text-red-700"
                        : "text-slate-400"
                    )}
                  >
                    {meta.label}
                    {/* 显示原始 ID 用于调试或如果它是未知的 */}
                    {!STEP_METADATA[step.step] && (
                      <span className="ml-2 text-[10px] text-slate-400 font-mono">
                        ({step.step})
                      </span>
                    )}
                  </p>

                  <span className="text-[10px] text-slate-400">
                    {step.timestamp
                      ? new Date(step.timestamp).toLocaleTimeString()
                      : ""}
                  </span>
                </div>

                {/* 消息 */}
                <div
                  className={cn(
                    "text-xs leading-relaxed transition-colors",
                    step.status === "error" ? "text-red-600" : "text-slate-500"
                  )}
                >
                  {step.message || "准备就绪..."}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
