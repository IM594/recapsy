import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { CheckCircle2, Copy, Download, FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";

interface ResultCardProps {
  summary: string;
  outputPath?: string;
  onRegenerate?: (prompt: string) => Promise<void>;
  isRegenerating?: boolean;
}

import { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { RefreshCw, Settings2 } from "lucide-react";

export function ResultCard({
  summary,
  outputPath,
  onRegenerate,
  isRegenerating = false,
}: ResultCardProps) {
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");

  const handleRegenerate = async () => {
    if (onRegenerate) {
      await onRegenerate(customPrompt);
      setCustomPrompt(""); // Clear after success
      setShowRegenerate(false);
    }
  };
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

  return (
    <Card className="overflow-hidden border-slate-200 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500">
      <CardHeader className="bg-white border-b border-slate-100 pb-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <CardTitle className="flex items-center gap-2 text-slate-800">
            <CheckCircle2 className="h-5 w-5 text-green-500" />
            生成完成
          </CardTitle>

          <div className="flex gap-2">
            {onRegenerate && (
              <Button
                variant={showRegenerate ? "secondary" : "outline"}
                size="sm"
                onClick={() => setShowRegenerate(!showRegenerate)}
              >
                <Settings2 className="h-4 w-4 mr-2" />
                Refine
              </Button>
            )}
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

        {showRegenerate && (
          <div className="mt-4 p-4 bg-slate-50 rounded-lg border border-slate-200 animate-in slide-in-from-top-2">
            <div className="space-y-3">
              <Textarea
                placeholder="输入额外指令（例如：'精简一些'、'重点关注 Bug 修复'...）"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                className="bg-white resize-none text-sm"
                rows={3}
              />
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  onClick={handleRegenerate}
                  disabled={isRegenerating}
                >
                  {isRegenerating ? (
                    <RefreshCw className="h-3 w-3 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3 mr-2" />
                  )}
                  {isRegenerating ? "重新生成中..." : "重新生成"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardHeader>

      <CardContent className="p-0 bg-white">
        <ScrollArea className="h-[500px] w-full p-6">
          <article className="prose prose-slate max-w-none prose-p:leading-relaxed prose-headings:font-semibold">
            <ReactMarkdown>{summary}</ReactMarkdown>
          </article>
        </ScrollArea>

        {outputPath && (
          <>
            <Separator />
            <div className="p-4 bg-slate-50/50 flex items-center gap-2 text-xs text-slate-500">
              <FileText className="h-3 w-3 flex-shrink-0" />
              <span className="truncate font-mono" title={outputPath}>
                {outputPath}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
