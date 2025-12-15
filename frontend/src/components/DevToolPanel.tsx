import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Play,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";

interface Repo {
  name: string;
  path: string;
}

interface DevToolResponse {
  success: boolean;
  nodeName: string;
  executionTimeMs: number;
  output?: any;
  error?: string;
}

type TestMode =
  | "collect_data"
  | "daily_summary"
  | "monthly_summary"
  | "yearly_summary"
  | "full_pipeline";

export function DevToolPanel() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [author, setAuthor] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [testMode, setTestMode] = useState<TestMode>("collect_data");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Map<string, DevToolResponse>>(
    new Map()
  );
  const [isExpanded, setIsExpanded] = useState(false);

  // Preload daily summaries
  const [preloadJson, setPreloadJson] = useState("");
  const [preloadedData, setPreloadedData] = useState<any[] | null>(null);

  // Load repos from environment or API
  useEffect(() => {
    const fetchRepos = async () => {
      try {
        const response = await fetch(
          "http://localhost:3456/api/repos?rootPath=/Users/user/Downloads/projects"
        );
        if (response.ok) {
          const data = await response.json();
          setRepos(data.repos || []);
        }
      } catch (error) {
        console.error("Failed to load repos:", error);
      }
    };
    fetchRepos();

    // Set default dates
    const now = new Date();
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    setSince(weekAgo.toISOString().split("T")[0]);
    setUntil(now.toISOString().split("T")[0]);
  }, []);

  const toggleRepo = (path: string) => {
    setSelectedRepos((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  const executeNode = async (
    nodeName: string,
    input: any
  ): Promise<DevToolResponse> => {
    const response = await fetch(
      "http://localhost:3456/api/devtool/test-node",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeName, input }),
      }
    );
    return response.json();
  };

  const handleLoadPreloadData = () => {
    try {
      const parsed = JSON.parse(preloadJson);
      if (!Array.isArray(parsed)) {
        toast.error("JSON 必须是一个数组");
        return;
      }
      setPreloadedData(parsed);
      toast.success(`成功加载 ${parsed.length} 条记录`);
    } catch (error) {
      toast.error("JSON 格式错误，请检查");
    }
  };

  const handleTest = async () => {
    // 如果有预加载数据，且测试模式是 monthly 或 yearly，则跳过前面的步骤
    const skipEarlySteps =
      preloadedData &&
      (testMode === "monthly_summary" ||
        testMode === "yearly_summary" ||
        testMode === "full_pipeline");

    if (!skipEarlySteps) {
      if (selectedRepos.length === 0) {
        toast.error("请至少选择一个仓库");
        return;
      }
      if (!author) {
        toast.error("请输入 Author");
        return;
      }
    }

    setLoading(true);
    setResults(new Map());

    try {
      const newResults = new Map<string, DevToolResponse>();
      let dailySummaries: any[] | null = null;

      // 如果有预加载数据，直接使用
      if (skipEarlySteps) {
        dailySummaries = preloadedData;
        toast.info(`使用预加载的 ${dailySummaries!.length} 条日摘要`);

        // 存储到 results 中供显示
        newResults.set("daily_summaries", {
          success: true,
          nodeName: "daily_summarizer",
          executionTimeMs: 0,
          output: dailySummaries,
        });
        setResults(new Map(newResults));
      } else {
        // Step 1: Collect data
        toast.info("正在收集数据...");
        const collectResult = await executeNode("collect_data", {
          repos: selectedRepos,
          since,
          until,
          authorPattern: author,
        });
        newResults.set("collect_data", collectResult);
        setResults(new Map(newResults));

        if (!collectResult.success) {
          toast.error(`数据收集失败: ${collectResult.error}`);
          return;
        }

        const dailyData = collectResult.output as any[];
        if (!dailyData || dailyData.length === 0) {
          toast.warning("未找到符合条件的提交记录");
          return;
        }

        toast.success(`收集到 ${dailyData.length} 天的数据`);

        // Stop here if only testing collect_data
        if (testMode === "collect_data") {
          return;
        }

        // Step 2: Daily summaries (concurrent processing)
        if (
          testMode === "daily_summary" ||
          testMode === "monthly_summary" ||
          testMode === "yearly_summary" ||
          testMode === "full_pipeline"
        ) {
          toast.info(`正在并发生成 ${dailyData.length} 天的日摘要...`);

          // 并发生成所有日摘要
          const dailyPromises = dailyData.map((dayData) =>
            executeNode("daily_summarizer", dayData)
          );
          const dailyResults = await Promise.all(dailyPromises);

          // 收集成功的结果
          dailySummaries = dailyResults
            .filter((r) => r.success)
            .map((r) => r.output);

          const failedCount = dailyResults.length - dailySummaries.length;
          if (failedCount > 0) {
            toast.warning(`${failedCount} 天的摘要生成失败`);
          }

          if (dailySummaries.length === 0) {
            toast.error("未能生成任何日摘要");
            return;
          }

          // 将所有 daily summaries 存储到 results 中
          newResults.set("daily_summaries", {
            success: true,
            nodeName: "daily_summarizer",
            executionTimeMs: dailyResults.reduce(
              (sum, r) => sum + r.executionTimeMs,
              0
            ),
            output: dailySummaries,
          });
          setResults(new Map(newResults));

          toast.success(`成功生成 ${dailySummaries.length} 天的日摘要`);

          if (testMode === "daily_summary") {
            return;
          }
        }
      }

      // Step 3: Monthly summary (aggregate all daily summaries)
      if (!dailySummaries) {
        toast.error("缺少日摘要数据");
        return;
      }

      toast.info(`正在聚合 ${dailySummaries.length} 天的摘要为月度报告...`);
      // 从第一个摘要的日期提取月份
      const month =
        dailySummaries[0]?.date?.substring(0, 7) || since.substring(0, 7);
      const monthlyResult = await executeNode("monthly_summarizer", {
        month,
        dailySummaries,
      });
      newResults.set("monthly_summary", monthlyResult);
      setResults(new Map(newResults));

      if (!monthlyResult.success) {
        toast.error(`月摘要失败: ${monthlyResult.error}`);
        return;
      }

      toast.success("月摘要生成成功");

      if (testMode === "monthly_summary") {
        return;
      }

      // Step 4: Yearly summary
      if (testMode === "yearly_summary" || testMode === "full_pipeline") {
        toast.info("正在生成年度总结...");
        const monthlySummary = newResults.get("monthly_summary")?.output;
        if (!monthlySummary) {
          toast.error("缺少月度摘要数据");
          return;
        }

        // 从月度摘要的 month 字段提取年份
        const year = parseInt(
          monthlySummary.month?.substring(0, 4) || since.substring(0, 4)
        );
        const yearlyResult = await executeNode("yearly_summarizer", {
          year,
          monthlySummaries: [monthlySummary], // In real scenario, would have 12 months
        });
        newResults.set("yearly_summary", yearlyResult);
        setResults(new Map(newResults));

        if (!yearlyResult.success) {
          toast.error(`年度总结失败: ${yearlyResult.error}`);
          return;
        }

        toast.success("年度总结生成成功！");
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      toast.error(`测试失败: ${errMsg}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="w-full border-dashed border-2 border-slate-300">
      <CardHeader
        className="cursor-pointer hover:bg-slate-50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              🔧 Node DevTool
              <Badge variant="secondary" className="text-xs">
                一条龙测试
              </Badge>
            </CardTitle>
            <CardDescription className="text-xs">
              选择仓库和作者，一键测试工作流
            </CardDescription>
          </div>
          {isExpanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </div>
      </CardHeader>

      {isExpanded && (
        <CardContent className="space-y-4">
          {/* Repo Selection */}
          <div className="space-y-2">
            <Label>
              选择仓库 ({selectedRepos.length}/{repos.length})
            </Label>
            <div className="border rounded-lg max-h-32 overflow-y-auto">
              {repos.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground text-center">
                  暂无仓库
                </div>
              ) : (
                <div className="divide-y">
                  {repos.map((repo) => (
                    <label
                      key={repo.path}
                      className="flex items-center gap-2 p-2 hover:bg-slate-50 cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedRepos.includes(repo.path)}
                        onCheckedChange={() => toggleRepo(repo.path)}
                      />
                      <span className="text-sm font-medium">{repo.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Author */}
          <div className="space-y-2">
            <Label>Author Pattern</Label>
            <Input
              placeholder="例如：your-name"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
            />
          </div>

          {/* Date Range */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>开始日期</Label>
              <Input
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>结束日期</Label>
              <Input
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </div>
          </div>

          {/* Preload Daily Summaries */}
          <div className="space-y-2 border-t pt-4">
            <Label>📥 预加载日摘要（可选）</Label>
            <p className="text-xs text-muted-foreground">
              粘贴已有的 daily_summaries JSON 数组，可跳过数据收集和日摘要生成
            </p>
            <textarea
              className="w-full h-24 p-2 text-xs font-mono border rounded-lg resize-none"
              placeholder='{"date":"2025-01-01","summary":"...","keyChanges":[...]}'
              value={preloadJson}
              onChange={(e) => setPreloadJson(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleLoadPreloadData}
                disabled={!preloadJson.trim()}
              >
                加载数据
              </Button>
              {preloadedData && (
                <Badge variant="default" className="text-xs">
                  ✓ 已加载 {preloadedData.length} 条
                </Badge>
              )}
            </div>
          </div>

          {/* Test Mode */}
          <div className="space-y-2">
            <Label>测试模式</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant={testMode === "collect_data" ? "default" : "outline"}
                size="sm"
                onClick={() => setTestMode("collect_data")}
              >
                仅数据收集
              </Button>
              <Button
                variant={testMode === "daily_summary" ? "default" : "outline"}
                size="sm"
                onClick={() => setTestMode("daily_summary")}
              >
                到日摘要
              </Button>
              <Button
                variant={testMode === "monthly_summary" ? "default" : "outline"}
                size="sm"
                onClick={() => setTestMode("monthly_summary")}
              >
                到月摘要
              </Button>
              <Button
                variant={testMode === "yearly_summary" ? "default" : "outline"}
                size="sm"
                onClick={() => setTestMode("yearly_summary")}
              >
                到年度总结
              </Button>
            </div>
          </div>

          {/* Execute Button */}
          <Button
            className="w-full"
            onClick={handleTest}
            disabled={
              loading ||
              (!preloadedData && (selectedRepos.length === 0 || !author))
            }
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                执行中...
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                开始测试
              </>
            )}
          </Button>

          {/* Results */}
          {results.size > 0 && (
            <div className="space-y-3 border-t pt-4">
              <Label className="text-base">测试结果</Label>

              {Array.from(results.entries()).map(([nodeName, result]) => (
                <div key={nodeName} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {result.success ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <div className="h-4 w-4 rounded-full bg-red-500" />
                      )}
                      <span className="font-medium text-sm">{nodeName}</span>
                      <Badge
                        variant={result.success ? "default" : "destructive"}
                        className="text-xs"
                      >
                        {result.success ? "成功" : "失败"}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {result.executionTimeMs}ms
                      </span>
                    </div>
                  </div>

                  <div className="bg-slate-900 text-slate-100 p-3 rounded-lg overflow-auto max-h-48">
                    <pre className="text-xs font-mono whitespace-pre-wrap">
                      {result.error
                        ? `Error: ${result.error}`
                        : JSON.stringify(result.output, null, 2)}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
