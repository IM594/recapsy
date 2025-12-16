import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Sparkles,
  CalendarRange,
  FolderGit2,
  User,
  ArrowRight,
  Clock,
  CheckCircle2,
} from "lucide-react";

interface GenerationPreviewProps {
  mode: "generate" | "regenerate";
  year: number;
  since: string;
  until: string;
  repos: string[];
  author: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function GenerationPreview({
  mode,
  year,
  since,
  until,
  repos,
  author,
  onConfirm,
  onCancel,
}: GenerationPreviewProps) {
  const steps = [
    {
      id: "collect",
      title: "Collecting Data",
      description: "Scanning git history across all repositories",
    },
    {
      id: "daily",
      title: "Analyzing Days",
      description: "Generating daily summaries with AI",
    },
    {
      id: "monthly",
      title: "Structuring Months",
      description: "Aggregating monthly reports",
    },
    {
      id: "yearly",
      title: "Finalizing Review",
      description: "Writing executive summary",
    },
  ];

  return (
    <Card className="max-w-2xl mx-auto border-2 shadow-lg animate-in zoom-in-95 duration-500">
      <CardHeader className="text-center pb-4 border-b bg-gradient-to-br from-indigo-50 to-purple-50">
        <div className="mx-auto bg-white p-3 rounded-full w-fit mb-4 shadow-sm ring-2 ring-indigo-100">
          <Sparkles className="h-8 w-8 text-indigo-600" />
        </div>
        <CardTitle className="text-2xl">
          {mode === "regenerate" ? "重新生成" : "生成"} {year} 年度总结
        </CardTitle>
        <CardDescription className="text-base mt-2">
          {mode === "regenerate"
            ? "将重新生成整个年度总结,现有数据将被覆盖"
            : "即将开始分析您的年度工作成果"}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6 pt-6">
        {/* Scope Information */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
            任务范围
          </h3>

          <div className="grid gap-3">
            {/* Date Range */}
            <div className="flex items-start gap-3 p-3 rounded-lg bg-slate-50 border border-slate-200">
              <CalendarRange className="h-5 w-5 text-slate-600 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-900">
                  时间范围
                </div>
                <div className="text-sm text-slate-600 mt-1">
                  {since} 至 {until}
                </div>
              </div>
            </div>

            {/* Repositories */}
            <div className="flex items-start gap-3 p-3 rounded-lg bg-slate-50 border border-slate-200">
              <FolderGit2 className="h-5 w-5 text-slate-600 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-900">
                  代码仓库
                </div>
                <div className="text-sm text-slate-600 mt-1">
                  {repos.length} 个仓库
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {repos.slice(0, 3).map((repo) => (
                    <Badge
                      key={repo}
                      variant="secondary"
                      className="text-xs font-mono"
                    >
                      {repo}
                    </Badge>
                  ))}
                  {repos.length > 3 && (
                    <Badge variant="outline" className="text-xs">
                      +{repos.length - 3} 更多
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            {/* Author */}
            <div className="flex items-start gap-3 p-3 rounded-lg bg-slate-50 border border-slate-200">
              <User className="h-5 w-5 text-slate-600 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-900">作者</div>
                <div className="text-sm text-slate-600 mt-1">
                  {author || "所有提交者"}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Process Steps */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
            执行步骤
          </h3>

          <div className="space-y-2">
            {steps.map((step, index) => (
              <div
                key={step.id}
                className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 bg-white"
              >
                <div className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-xs font-semibold shrink-0 mt-0.5">
                  {index + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-900">
                    {step.title}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {step.description}
                  </div>
                </div>
                {index < steps.length - 1 && (
                  <ArrowRight className="h-4 w-4 text-slate-300 mt-1.5" />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Estimated Time */}
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200">
          <Clock className="h-4 w-4 text-amber-600" />
          <span className="text-sm text-amber-900">
            预计耗时: 根据数据量,可能需要几分钟到十几分钟
          </span>
        </div>

        {/* Warning for Regenerate */}
        {mode === "regenerate" && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-orange-50 border border-orange-200">
            <div className="text-orange-600 mt-0.5">⚠️</div>
            <div className="text-sm text-orange-900">
              <strong>注意:</strong>{" "}
              重新生成将覆盖现有的年度总结数据。此操作不可撤销。
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-3 pt-4">
          <Button
            variant="outline"
            onClick={onCancel}
            className="flex-1"
            size="lg"
          >
            取消
          </Button>
          <Button onClick={onConfirm} className="flex-1" size="lg">
            <CheckCircle2 className="h-4 w-4 mr-2" />
            确认{mode === "regenerate" ? "重新生成" : "开始生成"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
