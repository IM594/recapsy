import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CalendarDays,
  CalendarRange,
  Calendar,
  FolderSearch,
} from "lucide-react";
import { toast } from "sonner";

interface InputFormProps {
  onSubmit: (data: {
    selectedRepos: string[];
    since?: string;
    until?: string;
    summaryType?: "today" | "week" | "month";
  }) => Promise<void>;
  loading: boolean;
}

interface Repo {
  name: string;
  path: string;
}

// 从环境变量或默认值读取扫描路径
const DEFAULT_SCAN_PATH = "/Users/user/Downloads/projects";

export function InputForm({ onSubmit, loading }: InputFormProps) {
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [scanning, setScanning] = useState(false);

  // 页面加载时自动扫描
  useEffect(() => {
    scanRepos();
  }, []);

  const scanRepos = async () => {
    setScanning(true);
    try {
      const response = await fetch(
        `http://localhost:3456/api/repos?rootPath=${encodeURIComponent(
          DEFAULT_SCAN_PATH
        )}`
      );
      if (!response.ok) throw new Error("扫描失败");
      const data = await response.json();
      setRepos(data.repos || []);
      toast.success(`发现 ${data.repos?.length || 0} 个仓库`);
    } catch (error) {
      console.error("扫描失败:", error);
      toast.error("扫描仓库失败");
    } finally {
      setScanning(false);
    }
  };

  const toggleRepo = (path: string) => {
    setSelectedRepos((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  const selectAll = () => {
    setSelectedRepos(repos.map((r) => r.path));
  };

  const selectNone = () => {
    setSelectedRepos([]);
  };

  // Helper to format date as YYYY-MM-DD HH:MM:SS (Local Time)
  const formatLocal = (date: Date) => {
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate()
    )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
      date.getSeconds()
    )}`;
  };

  const getStartOfDay = (date: Date) => {
    const newDate = new Date(date);
    newDate.setHours(0, 0, 0, 0);
    return newDate;
  };

  const handleQuickSummary = async (type: "today" | "week" | "month") => {
    if (selectedRepos.length === 0) {
      toast.error("请先选择至少一个仓库");
      return;
    }

    const now = new Date();
    let since = "";

    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    const until = formatLocal(endOfToday);

    if (type === "today") {
      since = formatLocal(getStartOfDay(now));
    } else if (type === "week") {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(now);
      monday.setDate(diff);
      since = formatLocal(getStartOfDay(monday));
    } else if (type === "month") {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      since = formatLocal(getStartOfDay(firstDay));
    }

    toast.info(
      `正在生成${
        type === "today" ? "今日" : type === "week" ? "本周" : "本月"
      }总结`
    );

    await onSubmit({
      selectedRepos,
      since,
      until,
      summaryType: type,
    });
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Generate Summary</CardTitle>
        <CardDescription>选择仓库，一键生成工作总结</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 仓库选择 */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-base font-medium">
              📍 选择仓库 ({selectedRepos.length}/{repos.length})
            </Label>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={selectAll}
                disabled={loading}
              >
                全选
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={selectNone}
                disabled={loading}
              >
                清空
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={scanRepos}
                disabled={scanning || loading}
              >
                <FolderSearch className="h-4 w-4 mr-1" />
                {scanning ? "扫描中..." : "重新扫描"}
              </Button>
            </div>
          </div>

          <div className="border rounded-lg max-h-48 overflow-y-auto">
            {repos.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground">
                {scanning ? "正在扫描..." : "暂无仓库，点击扫描"}
              </div>
            ) : (
              <div className="divide-y">
                {repos.map((repo) => (
                  <label
                    key={repo.path}
                    className="flex items-center gap-3 p-3 hover:bg-slate-50 cursor-pointer"
                  >
                    <Checkbox
                      checked={selectedRepos.includes(repo.path)}
                      onCheckedChange={() => toggleRepo(repo.path)}
                    />
                    <span className="font-medium">{repo.name}</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {repo.path}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 快速总结按钮 */}
        <div className="grid grid-cols-3 gap-4">
          <Button
            variant="outline"
            className="h-20 flex flex-col gap-2 hover:border-primary hover:text-primary transition-colors"
            onClick={() => handleQuickSummary("today")}
            disabled={loading || selectedRepos.length === 0}
          >
            <CalendarDays className="h-6 w-6" />
            <span>今日总结</span>
          </Button>
          <Button
            variant="outline"
            className="h-20 flex flex-col gap-2 hover:border-primary hover:text-primary transition-colors"
            onClick={() => handleQuickSummary("week")}
            disabled={loading || selectedRepos.length === 0}
          >
            <CalendarRange className="h-6 w-6" />
            <span>本周总结</span>
          </Button>
          <Button
            variant="outline"
            className="h-20 flex flex-col gap-2 hover:border-primary hover:text-primary transition-colors"
            onClick={() => handleQuickSummary("month")}
            disabled={loading || selectedRepos.length === 0}
          >
            <Calendar className="h-6 w-6" />
            <span>本月总结</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
