import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getSummaryApiUrl } from "@/lib/api";

import { useSummary } from "@/hooks/useSummary";
import { JournalSidebar } from "./unified-board/JournalSidebar";
import { JournalEntry } from "./unified-board/JournalEntry";
import {
  Structure,
  NavigationNode,
  DailyInfo,
} from "./unified-board/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface UnifiedBoardProps {
  year?: number;
}

export function UnifiedBoard({
  year = new Date().getFullYear(),
}: UnifiedBoardProps) {
  const [structure, setStructure] = useState<Structure | null>(null);
  const [selectedNode, setSelectedNode] = useState<NavigationNode | null>(null);
  const [content, setContent] = useState<string>("");
  const [loadingContent, setLoadingContent] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [repoPicker, setRepoPicker] = useState<{
    open: boolean;
    date: string;
    options: string[];
    repo: string;
  }>({ open: false, date: "", options: [], repo: "" });

  const {
    getYearlySummary,
    getMonthlySummaries,
    getDailySummaries,
    getWeeklySummaries,
    refetchData,
  } = useSummary();

  // Load structure
  useEffect(() => {
    fetchStructure();
  }, [year]);

  // Load content when selection changes
  useEffect(() => {
    if (selectedNode) {
      loadContent(selectedNode);
    }
  }, [selectedNode]);

  const fetchStructure = async () => {
    try {
      const [yearlyData, monthlyData, dailyData, weeklyData] =
        await Promise.all([
          getYearlySummary(year),
          getMonthlySummaries(year),
          getDailySummaries(year),
          getWeeklySummaries(year),
        ]);

      const hasYearlySummary = !!yearlyData?.content;

      // Organize daily data by month (preserve repo info)
      const monthMap = new Map<string, DailyInfo[]>();
      (dailyData || []).forEach((d: { date: string; repo: string }) => {
        const month = d.date.substring(0, 7);
        if (!monthMap.has(month)) monthMap.set(month, []);
        // Avoid duplicates
        const existing = monthMap.get(month)!;
        if (!existing.some((e) => e.date === d.date && e.repo === d.repo)) {
          existing.push({
            date: d.date,
            repo: d.repo,
            hasSummary: !!(d as any).summary,
          });
        }
      });

      const monthlyByMonth = new Map<string, { month: string; summary?: string }>(
        (monthlyData || []).map((m: { month: string; summary?: string }) => [
          m.month,
          m,
        ])
      );

      const monthsSet = new Set<string>([
        ...monthlyByMonth.keys(),
        ...monthMap.keys(),
      ]);

      const months = Array.from(monthsSet).sort((a, b) => a.localeCompare(b));

      const structure: Structure = {
        year,
        hasYearlySummary,
        months: months.map((month) => ({
          month,
          hasSummary: !!monthlyByMonth.get(month)?.summary,
          days: (monthMap.get(month) || []).sort((a, b) => {
            const dateCompare = a.date.localeCompare(b.date);
            if (dateCompare !== 0) return dateCompare;
            return a.repo.localeCompare(b.repo);
          }),
        })),
        weeks: (weeklyData || [])
          .map(
            (w: { weekStart: string; weekEnd: string; summary?: string }) => ({
              weekStart: w.weekStart,
              weekEnd: w.weekEnd,
              hasSummary: !!w.summary,
              title: `Week ${getWeekNumber(new Date(w.weekStart))}`,
            })
          )
          .sort(
            (
              a: {
                weekStart: string;
                weekEnd: string;
                hasSummary: boolean;
                title: string;
              },
              b: {
                weekStart: string;
                weekEnd: string;
                hasSummary: boolean;
                title: string;
              }
            ) => a.weekStart.localeCompare(b.weekStart)
          ),
      };

      setStructure(structure);
    } catch (error) {
      console.error(error);
      toast.error("Failed to load board structure");
    }
  };

  const loadContent = async (node: NavigationNode) => {
    setLoadingContent(true);
    try {
      if (node.type === "yearly") {
        const data = await getYearlySummary(year);
        setContent(data.content || "");
      } else if (node.type === "monthly") {
        const data = await getMonthlySummaries(year);
        const monthData = data.find((m: any) => m.month === node.id);
        setContent(monthData?.summary || "");
      } else if (node.type === "weekly") {
        const data = await getWeeklySummaries(year);
        // id is weekStart
        const weekData = data.find((w: any) => w.weekStart === node.id);
        setContent(weekData?.summary || "");
      } else {
        const data = await getDailySummaries(year);
        const matches = (data || []).filter((d: any) => d.date === node.id);
        if (matches.length === 0) {
          setContent("");
          return;
        }

        if (node.repo) {
          const exact = matches.find((d: any) => d.repo === node.repo);
          setContent(exact?.summary || "");
          return;
        }

        if (matches.length === 1) {
          setSelectedNode((prev) => (prev ? { ...prev, repo: matches[0].repo } : prev));
          setContent(matches[0].summary || "");
          return;
        }

        const options = matches
          .map((d: any) => d.repo)
          .filter(Boolean)
          .slice()
          .sort((a: string, b: string) => a.localeCompare(b));

        setRepoPicker({
          open: true,
          date: node.id,
          options,
          repo: options[0] || "",
        });
        setContent("");
      }
    } catch {
      toast.error("Failed to load content");
    } finally {
      setLoadingContent(false);
    }
  };

  const handleRegenerate = async (customPrompt: string) => {
    if (!selectedNode) return;

    // Daily type requires repo
    if (selectedNode.type === "daily" && !selectedNode.repo) {
      toast.error("Missing repo info for daily regeneration");
      return;
    }

    setRegenerating(true);
    try {
      const res = await fetch(getSummaryApiUrl("/regenerate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: selectedNode.type,
          id: selectedNode.id,
          year,
          customPrompt: customPrompt.trim() || undefined,
          repo: selectedNode.repo,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        toast.success("Regeneration successful!");
        // Update local content
        if (data.summary) setContent(data.summary);
        else if (data.content) setContent(data.content);

        // Reload structure and notify global state
        fetchStructure();
        refetchData();
      } else {
        toast.error(`Failed: ${data.error}`);
      }
    } catch {
      toast.error("Network error during regeneration");
    } finally {
      setRegenerating(false);
    }
  };

  if (!structure) {
    return (
      <div className="p-8 text-center text-muted-foreground animate-pulse">
        Loading board...
      </div>
    );
  }

  return (
    <>
      <Dialog
        open={repoPicker.open}
        onOpenChange={(open) =>
          setRepoPicker((prev) => ({ ...prev, open }))
        }
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Select repository</DialogTitle>
            <DialogDescription>
              Multiple repositories have daily summaries for {repoPicker.date}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-2">
            <Label>Repository</Label>
            <Select
              value={repoPicker.repo}
              onValueChange={(repo) => setRepoPicker((prev) => ({ ...prev, repo }))}
            >
              <SelectTrigger aria-label="Select repository" className="bg-white">
                <SelectValue placeholder="Select repository" />
              </SelectTrigger>
              <SelectContent>
                {repoPicker.options.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setRepoPicker((prev) => ({ ...prev, open: false }))}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                const repo = repoPicker.repo;
                if (!repo) return;
                setSelectedNode((prev) => {
                  if (!prev || prev.type !== "daily" || prev.id !== repoPicker.date) {
                    return prev;
                  }
                  return { ...prev, repo };
                });
                setRepoPicker((prev) => ({ ...prev, open: false }));
              }}
              disabled={!repoPicker.repo}
            >
              Open
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-12 h-[calc(100vh-10rem)] bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
      {/* Sidebar - Timeline Navigation */}
      <div className="col-span-3 h-full overflow-hidden border-r bg-slate-50">
        <JournalSidebar
          structure={structure}
          selectedNode={selectedNode}
          onSelect={setSelectedNode}
          className="h-full"
        />
      </div>

      {/* Main Content Area */}
      <div className="col-span-9 h-full overflow-hidden bg-white relative">
        {selectedNode ? (
          <JournalEntry
            node={selectedNode}
            content={content}
            loading={loadingContent}
            onRegenerate={handleRegenerate}
            isRegenerating={regenerating}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-slate-400">
            <div className="h-16 w-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
              <span className="text-2xl">📓</span>
            </div>
            <p className="text-lg font-medium text-slate-500">
              Select an entry to view details
            </p>
            <p className="text-sm">
              Explore your work history using the heatmap or timeline
            </p>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

// Utility to get week number
function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
