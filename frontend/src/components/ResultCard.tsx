import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  CheckCircle2,
  Copy,
  Download,
  FileText,
  Clock,
  GitBranch,
  Settings,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";

interface ResultCardProps {
  summary: string;
  outputPath: string;
  threadId?: string;
  timeRange?: { since: string; until: string };
  configName?: string;
  repoCount?: number;
}

export function ResultCard({
  summary,
  outputPath,
  threadId,
  timeRange,
  configName,
  repoCount,
}: ResultCardProps) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      toast.success("内容已复制到剪贴板");
    } catch (err) {
      toast.error("复制失败");
    }
  };

  const handleDownload = () => {
    try {
      const blob = new Blob([summary], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `summary-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("开始下载 Markdown 文件");
    } catch (err) {
      toast.error("下载失败");
    }
  };

  const handleCopyPath = () => {
    try {
      navigator.clipboard.writeText(outputPath);
      toast.success("文件路径已复制");
    } catch (err) {
      toast.error("复制路径失败");
    }
  };

  return (
    <Card className="overflow-hidden border-slate-200 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500">
      <CardHeader className="bg-white border-b border-slate-100 pb-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-slate-800">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              生成完成
            </CardTitle>
            {/* Metadata Badges */}
            <div className="flex flex-wrap gap-2 pt-1">
              {threadId && (
                <Badge
                  variant="secondary"
                  className="text-xs font-mono text-slate-500 bg-slate-100/50"
                >
                  Thread: {threadId.slice(0, 8)}
                </Badge>
              )}
              {configName && (
                <Badge variant="outline" className="text-xs gap-1">
                  <Settings className="h-3 w-3" />
                  {configName}
                </Badge>
              )}
              {repoCount !== undefined && (
                <Badge variant="outline" className="text-xs gap-1">
                  <GitBranch className="h-3 w-3" />
                  {repoCount} Repos
                </Badge>
              )}
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleCopy}>
              <Copy className="h-4 w-4 mr-2" />
              复制内容
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownload}
              className="text-slate-600"
            >
              <Download className="h-4 w-4 mr-2" />
              下载
            </Button>
          </div>
        </div>

        {timeRange && (
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-500 bg-slate-50 p-2 rounded border border-slate-100/50">
            <Clock className="h-3.5 w-3.5" />
            <span>时间范围:</span>
            <span className="font-mono">{timeRange.since}</span>
            <span>~</span>
            <span className="font-mono">{timeRange.until || "Now"}</span>
          </div>
        )}
      </CardHeader>

      <CardContent className="p-0 bg-white">
        <ScrollArea className="h-[500px] w-full p-6">
          <article className="prose prose-slate max-w-none prose-p:leading-relaxed prose-headings:font-semibold prose-a:text-primary hover:prose-a:text-primary/80 prose-code:bg-slate-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none">
            <ReactMarkdown>{summary}</ReactMarkdown>
          </article>
        </ScrollArea>

        <Separator />

        <div className="p-4 bg-slate-50/50 flex items-center justify-between">
          <div
            className="flex items-center gap-2 text-xs text-slate-500 flex-1 min-w-0 mr-4 group cursor-pointer"
            onClick={handleCopyPath}
          >
            <FileText className="h-3 w-3 flex-shrink-0" />
            <span
              className="truncate font-mono group-hover:text-slate-700 transition-colors"
              title={outputPath}
            >
              {outputPath}
            </span>
            <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <Badge
            variant="outline"
            className="text-xs bg-white text-slate-500 font-normal shadow-sm"
          >
            Markdown Generated
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
