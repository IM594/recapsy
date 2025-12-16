import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import {
  Bot,
  Copy,
  RefreshCw,
  Sparkles,
  Calendar as CalendarIcon,
  Clock,
  Code2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { NavigationNode } from "./types";
import { cn } from "@/lib/utils";

interface JournalEntryProps {
  node: NavigationNode;
  content: string;
  loading: boolean;
  onRegenerate: (prompt: string) => Promise<void>;
  isRegenerating: boolean;
}

export function JournalEntry({
  node,
  content,
  loading,
  onRegenerate,
  isRegenerating,
}: JournalEntryProps) {
  const [showRefine, setShowRefine] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  const [tab, setTab] = useState<"read" | "source">("read");

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    toast.success("Copied to clipboard");
  };

  const handleRunRegenerate = async () => {
    if (customPrompt.trim()) {
      await onRegenerate(customPrompt);
      setShowRefine(false);
      setCustomPrompt("");
    }
  };

  return (
    <div className="h-full flex flex-col bg-white relative">
      {/* Header - Fixed height to avoid jumps */}
      <div className="px-8 py-6 border-b border-slate-100 flex items-start justify-between bg-white/80 backdrop-blur-sm z-20 shrink-0">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Badge
              variant="outline"
              className="uppercase tracking-widest text-[10px] text-slate-400 font-mono"
            >
              {node.type}
            </Badge>
            {node.repo && (
              <Badge
                variant="secondary"
                className="bg-blue-50 text-blue-700 text-[10px]"
              >
                {node.repo}
              </Badge>
            )}
          </div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">
            {node.label}
          </h1>
          <div className="flex items-center gap-4 mt-2 text-sm text-slate-500">
            <span className="flex items-center gap-1">
              <CalendarIcon className="h-3 w-3" />
              {node.id}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {(content.length / 500).toFixed(0)} min read
            </span>
          </div>
        </div>

        <div className="flex gap-2">
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as any)}
            className="mr-2"
          >
            <TabsList className="h-8">
              <TabsTrigger value="read" className="text-xs px-3">
                Read
              </TabsTrigger>
              <TabsTrigger value="source" className="text-xs px-3">
                Source
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowRefine(!showRefine)}
            title="Refine with AI"
          >
            <Sparkles
              className={cn(
                "h-4 w-4",
                showRefine
                  ? "text-indigo-600 fill-indigo-100"
                  : "text-slate-500"
              )}
            />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleCopy} title="Copy">
            <Copy className="h-4 w-4 text-slate-500" />
          </Button>
        </div>
      </div>

      {/* Refine Popover/Panel */}
      <AnimatePresence>
        {showRefine && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-b border-indigo-100 bg-indigo-50/30 overflow-hidden shrink-0"
          >
            <div className="p-4 px-8 flex gap-4 items-start max-w-3xl mx-auto">
              <Bot className="h-5 w-5 text-indigo-600 mt-2" />
              <div className="flex-1 space-y-2">
                <Textarea
                  placeholder="Tell AI how to improve this summary... (e.g., 'Make it more concise', 'Focus on the bug fix')"
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  className="bg-white/80 min-h-[80px] text-sm"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={handleRunRegenerate}
                    disabled={isRegenerating || !customPrompt.trim()}
                  >
                    {isRegenerating ? (
                      <RefreshCw className="h-3 w-3 animate-spin mr-2" />
                    ) : (
                      <Sparkles className="h-3 w-3 mr-2" />
                    )}
                    Regenerate
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Content Area */}
      <ScrollArea className="flex-1 bg-white">
        <div className="max-w-3xl mx-auto px-8 py-8 min-h-[600px]">
          <AnimatePresence mode="wait">
            {loading ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center justify-center h-64 space-y-4"
              >
                <div className="relative">
                  <div className="h-12 w-12 rounded-full border-4 border-slate-100 border-t-indigo-500 animate-spin" />
                  <Bot className="h-5 w-5 absolute inset-0 m-auto text-slate-300" />
                </div>
                <p className="text-slate-400 text-sm animate-pulse">
                  Consulting the archives...
                </p>
              </motion.div>
            ) : tab === "read" ? (
              <motion.article
                key="content"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="prose prose-slate prose-lg max-w-none
                 prose-headings:font-bold prose-headings:tracking-tight
                 prose-h1:text-4xl prose-h2:text-2xl prose-h2:mt-8 prose-h2:mb-4
                 prose-p:leading-relaxed prose-p:text-slate-600
                 prose-li:text-slate-600
                 prose-strong:text-slate-800
                 prose-code:text-indigo-600 prose-code:bg-indigo-50 prose-code:px-1 prose-code:rounded-sm prose-code:before:content-none prose-code:after:content-none"
              >
                {!content ? (
                  <div className="text-center py-20 text-slate-400 italic bg-slate-50 rounded-lg border border-dashed border-slate-200">
                    No journal entry for this date. <br />
                    Click "Refine" to generate one.
                  </div>
                ) : (
                  <ReactMarkdown>{content}</ReactMarkdown>
                )}
              </motion.article>
            ) : (
              <motion.div
                key="source"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-4"
              >
                <div className="p-4 bg-slate-900 rounded-lg text-slate-200 font-mono text-sm overflow-x-auto">
                  <div className="flex items-center gap-2 mb-4 text-slate-500 pb-2 border-b border-slate-800">
                    <Code2 className="h-4 w-4" />
                    Raw Context Data
                  </div>
                  <pre>
                    {/* Placeholder for raw data - ideally this would be passed in props or fetched */}
                    {JSON.stringify(
                      {
                        note: "Raw source view not yet implemented, showing node info",
                        ...node,
                      },
                      null,
                      2
                    )}
                  </pre>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </ScrollArea>
    </div>
  );
}
