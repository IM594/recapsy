import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfigSelector } from "./ConfigSelector";
import { ProgressDisplay } from "./ProgressDisplay";
import type { WorkflowStep } from "@/types/workflow";
import type { ProfileConfig } from "@/types";
import {
  CalendarDays,
  CalendarRange,
  Calendar,
  Bot,
  Play,
  Check,
  X,
} from "lucide-react";
import { toast } from "sonner";

interface InputFormProps {
  onSubmit: (data: {
    userInput: string;
    selectedRepos: string[];
    since?: string;
    until?: string;
    summaryType?: "today" | "week" | "month" | "custom";
  }) => Promise<void>;
  loading: boolean;
  workflowSteps: WorkflowStep[];
}

interface Plan {
  since: string;
  until: string;
  summaryType: "today" | "week" | "month" | "custom";
  focus: string;
}

export function InputForm({
  onSubmit,
  loading,
  workflowSteps,
}: InputFormProps) {
  const [userInput, setUserInput] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [currentConfig, setCurrentConfig] = useState<ProfileConfig | null>(
    null
  );

  // AI Command Mode States
  const [analyzing, setAnalyzing] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);

  // 当配置变化时,更新默认值
  const handleConfigChange = (config: ProfileConfig) => {
    setCurrentConfig(config);

    // 如果配置有默认仓库,自动设置
    if (config.git.defaultRepos && config.git.defaultRepos.length > 0) {
      setSelectedRepos(config.git.defaultRepos);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // 直接使用配置的时间设置
    let finalSince = "";
    let finalUntil = "";

    if (currentConfig?.git.timeMode === "absolute") {
      // 具体时间模式
      finalSince = currentConfig.git.absoluteSince || "";
      finalUntil = currentConfig.git.absoluteUntil || "";
    } else {
      // 相对时间模式
      finalSince = currentConfig?.git.since || "yesterday";
      finalUntil = currentConfig?.git.until || "";
    }

    console.log(
      "[UI] 准备提交",
      `仓库数量=${selectedRepos.length}, 输入长度=${userInput.length}, since=${finalSince}, until=${finalUntil}`
    );

    await onSubmit({
      userInput,
      selectedRepos,
      since: finalSince,
      until: finalUntil,
      summaryType: "custom",
    });
  };

  const handleQuickSummary = async (type: "today" | "week" | "month") => {
    const now = new Date();
    let since = "";

    // Helper to format date as YYYY-MM-DD HH:MM:SS (Local Time)
    const formatLocal = (date: Date) => {
      const pad = (n: number) => n.toString().padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
        date.getDate()
      )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
        date.getSeconds()
      )}`;
    };

    // Helper to get start of day in local time
    const getStartOfDay = (date: Date) => {
      const newDate = new Date(date);
      newDate.setHours(0, 0, 0, 0);
      return newDate;
    };

    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    const until = formatLocal(endOfToday);

    if (type === "today") {
      const start = getStartOfDay(now);
      since = formatLocal(start);
    } else if (type === "week") {
      // This Monday 00:00:00
      const day = now.getDay(); // 0 is Sunday
      const diff = now.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
      const monday = new Date(now);
      monday.setDate(diff);
      const start = getStartOfDay(monday);
      since = formatLocal(start);
    } else if (type === "month") {
      // 1st of this month 00:00:00
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const start = getStartOfDay(firstDay);
      since = formatLocal(start);
    }

    console.log(`[UI] 快速总结: ${type}, since=${since}, until=${until}`);

    await onSubmit({
      userInput,
      selectedRepos,
      since,
      until,
      summaryType: type,
    });
  };

  const handleAnalyzeCommand = async () => {
    if (!commandInput.trim()) return;

    setAnalyzing(true);
    setPlan(null);

    try {
      const response = await fetch("http://localhost:3456/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: commandInput }),
      });

      if (!response.ok) throw new Error("Analysis failed");

      const data = await response.json();
      setPlan(data);
      toast.success("计划已生成，请确认");
    } catch (error) {
      console.error("Analysis error:", error);
      toast.error("分析命令失败，请重试");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleExecutePlan = async () => {
    if (!plan) return;

    await onSubmit({
      userInput: plan.focus !== "everything" ? `Focus on: ${plan.focus}` : "",
      selectedRepos, // Use currently selected repos
      since: plan.since,
      until: plan.until,
      summaryType: plan.summaryType,
    });
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Generate Summary</CardTitle>
        <CardDescription>选择你的总结方式：快速模式或智能命令</CardDescription>
      </CardHeader>
      <CardContent>
        {/* 配置选择器 (Always visible) */}
        <div className="mb-6">
          <ConfigSelector onConfigChange={handleConfigChange} />
          {selectedRepos.length > 0 && (
            <div className="text-sm text-muted-foreground mt-2">
              已选中 {selectedRepos.length} 个仓库
            </div>
          )}
        </div>

        <Tabs defaultValue="quick" className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-6">
            <TabsTrigger value="quick">快速模式 (Quick Mode)</TabsTrigger>
            <TabsTrigger value="command">
              <Bot className="h-4 w-4 mr-2" />
              智能命令 (AI Command)
            </TabsTrigger>
          </TabsList>

          <TabsContent value="quick" className="space-y-6">
            {/* 快速操作按钮 */}
            <div className="grid grid-cols-3 gap-4">
              <Button
                variant="outline"
                className="h-20 flex flex-col gap-2 hover:border-primary hover:text-primary transition-colors"
                onClick={() => handleQuickSummary("today")}
                disabled={loading}
              >
                <CalendarDays className="h-6 w-6" />
                <span>今日总结</span>
              </Button>
              <Button
                variant="outline"
                className="h-20 flex flex-col gap-2 hover:border-primary hover:text-primary transition-colors"
                onClick={() => handleQuickSummary("week")}
                disabled={loading}
              >
                <CalendarRange className="h-6 w-6" />
                <span>本周总结</span>
              </Button>
              <Button
                variant="outline"
                className="h-20 flex flex-col gap-2 hover:border-primary hover:text-primary transition-colors"
                onClick={() => handleQuickSummary("month")}
                disabled={loading}
              >
                <Calendar className="h-6 w-6" />
                <span>本月总结</span>
              </Button>
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">
                  或者自定义生成
                </span>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="userInput">今日工作笔记 (可选)</Label>
                <Textarea
                  id="userInput"
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder="例如:完成了用户登录功能,修复了 API 接口的 bug..."
                  className="min-h-[100px]"
                />
              </div>

              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "正在生成总结..." : "生成工作总结"}
              </Button>
            </form>
          </TabsContent>

          <TabsContent value="command" className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="commandInput">输入你的需求</Label>
              <Textarea
                id="commandInput"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                placeholder="例如: 生成 12 月 1 日～今天的总结，重点关注 Bug 修复..."
                className="min-h-[100px] text-base"
              />
            </div>

            {!plan && (
              <Button
                onClick={handleAnalyzeCommand}
                disabled={analyzing || !commandInput.trim()}
                className="w-full"
              >
                {analyzing ? "正在分析..." : "生成方案"}
              </Button>
            )}

            {plan && (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-4 animate-in fade-in slide-in-from-top-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-slate-900 flex items-center gap-2">
                    <Check className="h-4 w-4 text-green-500" />
                    方案已生成
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPlan(null)}
                    className="h-8 w-8 p-0"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <div className="grid gap-3 text-sm">
                  <div className="grid grid-cols-[80px_1fr] gap-2">
                    <span className="text-slate-500">开始时间:</span>
                    <span className="font-mono font-medium">{plan.since}</span>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-2">
                    <span className="text-slate-500">结束时间:</span>
                    <span className="font-mono font-medium">
                      {plan.until || "Now"}
                    </span>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-2">
                    <span className="text-slate-500">类型:</span>
                    <span className="capitalize bg-blue-50 text-blue-700 px-2 py-0.5 rounded inline-block w-fit">
                      {plan.summaryType}
                    </span>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-2">
                    <span className="text-slate-500">关注点:</span>
                    <span>{plan.focus}</span>
                  </div>
                </div>

                <div className="pt-2 flex gap-3">
                  <Button
                    onClick={handleExecutePlan}
                    disabled={loading}
                    className="flex-1 bg-green-600 hover:bg-green-700"
                  >
                    <Play className="h-4 w-4 mr-2" />
                    {loading ? "执行中..." : "确认并执行"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setPlan(null)}
                    disabled={loading}
                  >
                    取消
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* 进度显示 (Shared) */}
        {workflowSteps.length > 0 && (
          <div className="mt-6">
            <ProgressDisplay steps={workflowSteps} currentStep={0} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
