import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import {
  CheckCircle2,
  Copy,
  Download,
  FileText,
  RefreshCw,
  Settings2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { COPY } from "@/constants/copy";
import { logError } from "@/lib/logger";

interface ResultCardProps {
  summary: string;
  outputPath?: string;
  title?: string;
  repo?: string;
  repoOptions?: string[];
  onRepoChange?: (repo: string) => void;
  onRegenerate?: (prompt: string) => Promise<void>;
  isRegenerating?: boolean;
}

export function ResultCard({
  summary,
  outputPath,
  title = COPY.resultCard.defaultTitle,
  repo,
  repoOptions,
  onRepoChange,
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
      toast.success(COPY.toasts.copiedToClipboard);
    } catch (error) {
      logError("resultCard.copy", error);
      toast.error(COPY.toasts.copyFailed);
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
      toast.success(COPY.toasts.downloadingMarkdown);
    } catch (error) {
      logError("resultCard.download", error);
      toast.error(COPY.toasts.downloadFailed);
    }
  };

  return (
    <Card className="overflow-hidden border-slate-200 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500">
      <CardHeader className="bg-white border-b border-slate-100 pb-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <CardTitle className="flex items-center gap-2 text-slate-800">
            <CheckCircle2 className="h-5 w-5 text-green-500" />
            {title}
          </CardTitle>

          <div className="flex gap-2 items-center flex-wrap">
            {repoOptions && repoOptions.length > 1 && onRepoChange && (
              <Select value={repo} onValueChange={onRepoChange}>
                <SelectTrigger
                  aria-label={COPY.common.aria.selectRepository}
                  className="h-9 w-[200px] bg-white"
                >
                  <SelectValue placeholder={COPY.common.placeholders.repository} />
                </SelectTrigger>
                <SelectContent>
                  {repoOptions.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {onRegenerate && (
              <Button
                variant={showRegenerate ? "secondary" : "outline"}
                size="sm"
                onClick={() => setShowRegenerate(!showRegenerate)}
              >
                <Settings2 className="h-4 w-4 mr-2" />
                {COPY.common.buttons.refine}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleCopy}>
              <Copy className="h-4 w-4 mr-2" />
              {COPY.common.buttons.copy}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownload}
              className="text-slate-600"
            >
              <Download className="h-4 w-4 mr-2" />
              {COPY.common.buttons.download}
            </Button>
          </div>
        </div>

        {showRegenerate && (
          <div className="mt-4 p-4 bg-slate-50 rounded-lg border border-slate-200 animate-in slide-in-from-top-2">
            <div className="space-y-3">
              <Textarea
                placeholder={COPY.resultCard.refinePlaceholder}
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
                  {isRegenerating
                    ? COPY.resultCard.regeneratingButtonLabel
                    : COPY.common.buttons.regenerate}
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
