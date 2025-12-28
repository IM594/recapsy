import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useSummary } from "../hooks/useSummary";

import { JournalSidebar } from "./unified-board/JournalSidebar";
import { JournalEntry } from "./unified-board/JournalEntry";
import {
  Structure,
  NavigationNode,
  DailyInfo,
  NodeType,
} from "./unified-board/types";

interface UnifiedBoardProps {
  year?: number;
}

export function UnifiedBoard({ year = 2025 }: UnifiedBoardProps) {
  const [structure, setStructure] = useState<Structure | null>(null);
  const [selectedNode, setSelectedNode] = useState<NavigationNode | null>(null);
  const [content, setContent] = useState<string>("");
  const [loadingContent, setLoadingContent] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

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
      loadContent(selectedNode.type, selectedNode.id);
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

      const structure: Structure = {
        year,
        hasYearlySummary,
        months: (monthlyData || [])
          .map((m: { month: string; summary?: string }) => ({
            month: m.month,
            hasSummary: !!m.summary,
            days: (monthMap.get(m.month) || []).sort(
              (a: DailyInfo, b: DailyInfo) => a.date.localeCompare(b.date)
            ),
          }))
          .sort(
            (
              a: { month: string; hasSummary: boolean; days: DailyInfo[] },
              b: { month: string; hasSummary: boolean; days: DailyInfo[] }
            ) => a.month.localeCompare(b.month)
          ),
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
      } else if (type === "weekly") {
        const data = await getWeeklySummaries(year);
        // id is weekStart
        const weekData = data.find((w: any) => w.weekStart === id);
        setContent(weekData?.summary || "");
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

  const handleRegenerate = async (customPrompt: string) => {
    if (!selectedNode) return;

    // Daily type requires repo
    if (selectedNode.type === "daily" && !selectedNode.repo) {
      toast.error("Missing repo info for daily regeneration");
      return;
    }

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
    } catch (error) {
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
  );
}

// Utility to get week number
function getWeekNumber(d: Date) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
  );
  return weekNo;
}
