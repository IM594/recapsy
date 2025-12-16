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
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Settings2,
  RefreshCw,
  CalendarDays,
  CalendarRange,
  LayoutTemplate,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { useSummary } from "../hooks/useSummary";

interface Structure {
  year: number;
  hasYearlySummary: boolean;
  months: {
    month: string;
    hasSummary: boolean;
    days: string[];
  }[];
}

interface YearEndReviewProps {
  year?: number;
}

type NodeType = "daily" | "monthly" | "yearly";

export function YearEndReview({ year = 2025 }: YearEndReviewProps) {
  const [structure, setStructure] = useState<Structure | null>(null);
  const [selectedNode, setSelectedNode] = useState<{
    type: NodeType;
    id: string;
  } | null>(null);
  const [content, setContent] = useState<string>("");
  const [loadingContent, setLoadingContent] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [expandedMonths, setExpandedMonths] = useState<string[]>([]);

  const { getYearlySummary, getMonthlySummaries, getDailySummaries } =
    useSummary();

  // Load structure
  useEffect(() => {
    fetchStructure();
  }, [year]);

  // Load content when selection changes
  useEffect(() => {
    if (selectedNode) {
      loadContent(selectedNode.type, selectedNode.id);
    }
  }, [selectedNode]);

  const fetchStructure = async () => {
    try {
      const [yearlyData, monthlyData, dailyData] = await Promise.all([
        getYearlySummary(year),
        getMonthlySummaries(year),
        getDailySummaries(year),
      ]);

      const hasYearlySummary = !!yearlyData?.content;

      // Organize daily data by month
      const monthMap = new Map<string, Set<string>>();
      (dailyData || []).forEach((d: any) => {
        const month = d.date.substring(0, 7);
        if (!monthMap.has(month)) monthMap.set(month, new Set());
        monthMap.get(month)!.add(d.date);
      });

      const structure: Structure = {
        year,
        hasYearlySummary,
        months: (monthlyData || [])
          .map((m: any) => ({
            month: m.month,
            hasSummary: !!m.summary,
            days: Array.from(monthMap.get(m.month) || []).sort(),
          }))
          .sort((a: any, b: any) => a.month.localeCompare(b.month)),
      };

      setStructure(structure);
    } catch (error) {
      console.error(error);
      toast.error("Failed to load year structure");
    }
  };

  const loadContent = async (type: NodeType, id: string) => {
    setLoadingContent(true);
    try {
      if (type === "yearly") {
        const data = await getYearlySummary(year);
        setContent(data.content || "");
      } else if (type === "monthly") {
        const data = await getMonthlySummaries(year);
        const monthData = data.find((m: any) => m.month === id);
        setContent(monthData?.summary || "");
      } else {
        const data = await getDailySummaries(year);
        const dayData = data.find((d: any) => d.date === id);
        setContent(dayData?.summary || "");
      }
    } catch (error) {
      toast.error("Failed to load content");
    } finally {
      setLoadingContent(false);
    }
  };

  const handleRegenerate = async () => {
    if (!selectedNode) return;

    setRegenerating(true);
    try {
      const res = await fetch("http://localhost:3456/api/summary/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: selectedNode.type,
          id: selectedNode.id,
          year,
          customPrompt: customPrompt.trim() || undefined,
          repo: "default",
        }),
      });

      const data = await res.json();

      if (res.ok) {
        toast.success("Regeneration successful!");
        // Reload content locally since regenerate returns result
        if (data.summary) setContent(data.summary);
        else if (data.content) setContent(data.content);

        // Reload structure if needed
        fetchStructure();
        setCustomPrompt("");
      } else {
        toast.error(`Failed: ${data.error}`);
      }
    } catch (error) {
      toast.error("Network error during regeneration");
    } finally {
      setRegenerating(false);
    }
  };

  const toggleMonth = (month: string) => {
    setExpandedMonths((prev) =>
      prev.includes(month) ? prev.filter((m) => m !== month) : [...prev, month]
    );
  };

  if (!structure) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Loading structure...
      </div>
    );
  }

  return (
    <div className="grid grid-cols-12 gap-6 h-[calc(100vh-12rem)] min-h-[500px]">
      {/* Sidebar - Tree View */}
      <Card className="col-span-3 flex flex-col h-full border-2 border-slate-200">
        <CardHeader className="py-4 px-4 bg-slate-50 border-b">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <LayoutTemplate className="h-4 w-4" />
            Year Structure ({year})
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 p-2 overflow-hidden">
          <ScrollArea className="h-full pr-2">
            <div className="space-y-1">
              {/* Yearly Summary Node */}
              <div
                className={`flex items-center gap-2 p-2 rounded-md cursor-pointer text-sm font-medium transition-colors ${
                  selectedNode?.type === "yearly"
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-slate-100"
                }`}
                onClick={() =>
                  setSelectedNode({ type: "yearly", id: String(year) })
                }
              >
                <FileText className="h-4 w-4" />
                Yearly Summary
                {structure.hasYearlySummary && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-green-500" />
                )}
              </div>

              {/* Monthly & Daily Nodes */}
              {structure.months.map((m) => (
                <div key={m.month} className="space-y-1">
                  <div
                    className={`flex items-center gap-2 p-2 rounded-md cursor-pointer text-sm transition-colors ${
                      selectedNode?.type === "monthly" &&
                      selectedNode.id === m.month
                        ? "bg-primary/10 text-primary font-medium"
                        : "hover:bg-slate-100"
                    }`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleMonth(m.month);
                      }}
                      className="p-1 hover:bg-slate-200 rounded"
                    >
                      {expandedMonths.includes(m.month) ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </button>
                    <span
                      className="flex-1 flex items-center gap-2"
                      onClick={() =>
                        setSelectedNode({ type: "monthly", id: m.month })
                      }
                    >
                      <CalendarRange className="h-4 w-4 text-slate-500" />
                      {m.month}
                      {m.hasSummary && (
                        <span className="ml-auto w-2 h-2 rounded-full bg-green-500" />
                      )}
                    </span>
                  </div>

                  {/* Daily Nodes (nested) */}
                  {expandedMonths.includes(m.month) && (
                    <div className="ml-9 border-l-2 pl-2 space-y-1 my-1">
                      {m.days.map((day) => (
                        <div
                          key={day}
                          className={`flex items-center gap-2 p-1.5 rounded-md cursor-pointer text-xs transition-colors ${
                            selectedNode?.type === "daily" &&
                            selectedNode.id === day
                              ? "bg-primary/5 text-primary font-medium"
                              : "hover:bg-slate-50 text-slate-600"
                          }`}
                          onClick={() =>
                            setSelectedNode({ type: "daily", id: day })
                          }
                        >
                          <CalendarDays className="h-3 w-3" />
                          {day}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Main Content - Preview & Regenerate */}
      <div className="col-span-9 flex flex-col h-full space-y-4">
        {selectedNode ? (
          <>
            <Card className="flex-1 flex flex-col border-2 overflow-hidden">
              <CardHeader className="py-3 px-6 bg-slate-50 border-b flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    {selectedNode.type === "yearly" && "🏆 Annual Self-Review"}
                    {selectedNode.type === "monthly" && "📅 Monthly Report"}
                    {selectedNode.type === "daily" && "📝 Daily Summary"}
                  </CardTitle>
                  <CardDescription>{selectedNode.id}</CardDescription>
                </div>
                <Badge variant="outline" className="font-mono">
                  {selectedNode.type.toUpperCase()}
                </Badge>
              </CardHeader>
              <CardContent className="flex-1 p-6 overflow-hidden">
                <ScrollArea className="h-full">
                  {loadingContent ? (
                    <div className="flex items-center justify-center h-40">
                      <span className="text-muted-foreground animate-pulse">
                        Loading content...
                      </span>
                    </div>
                  ) : (
                    <div className="prose prose-sm max-w-none dark:prose-invert">
                      <ReactMarkdown>{content}</ReactMarkdown>
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Regeneration Controls */}
            <Card className="border-2 border-indigo-100 bg-indigo-50/30">
              <CardContent className="p-4 flex gap-4 items-start">
                <div className="flex-1 space-y-2">
                  <Label className="flex items-center gap-2 text-indigo-700">
                    <Settings2 className="h-4 w-4" />
                    Refine & Regenerate
                  </Label>
                  <Textarea
                    placeholder={`Enter custom instructions to regenerate this ${selectedNode.type} summary... example: "Focus more on technical implementation details" or "Summarize more briefly"`}
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    className="bg-white resize-none text-sm"
                    rows={2}
                  />
                </div>
                <Button
                  className="mt-6"
                  onClick={handleRegenerate}
                  disabled={regenerating}
                >
                  {regenerating ? (
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  {regenerating ? "Processing..." : "Regenerate"}
                </Button>
              </CardContent>
            </Card>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center border-2 border-dashed rounded-lg bg-slate-50 text-slate-400">
            <div className="text-center">
              <LayoutTemplate className="h-12 w-12 mx-auto mb-2 opacity-20" />
              <p>Select a node from the tree to view and verify content</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
