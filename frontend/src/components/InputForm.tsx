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
import { ConfigSelector } from "./ConfigSelector";
import { ProgressDisplay } from "./ProgressDisplay";
import type { WorkflowStep } from "@/types/workflow";
import { CalendarDays, CalendarRange, Calendar } from "lucide-react";

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

interface ProfileConfig {
  name: string;
  git: {
    rootPaths: string[];
    defaultRepos?: string[];
    authorPattern?: string;
    timeMode?: "relative" | "absolute";
    since?: string;
    until?: string;
    absoluteSince?: string;
    absoluteUntil?: string;
  };
}

export function InputForm({
  onSubmit,
  loading,
  workflowSteps,
}: InputFormProps) {
  const [userInput, setUserInput] = useState("");
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [currentConfig, setCurrentConfig] = useState<ProfileConfig | null>(
    null
  );

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

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Generate</CardTitle>
        <CardDescription>
          {/* 系统会根据配置自动加载默认仓库和时间设置,您也可以临时修改 */}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
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
            {/* 配置选择器 */}
            <ConfigSelector onConfigChange={handleConfigChange} />

            {/* 显示选中的仓库数量 */}
            {selectedRepos.length > 0 && (
              <div className="text-sm text-muted-foreground">
                已选中 {selectedRepos.length} 个仓库
              </div>
            )}

            {/* 工作笔记 */}

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

            {/* 进度显示 */}
            {workflowSteps.length > 0 && (
              <ProgressDisplay steps={workflowSteps} currentStep={0} />
            )}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? "正在生成总结..." : "生成工作总结"}
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}
