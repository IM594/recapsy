import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useSummary } from "@/hooks/useSummary";
import { regenerateSummary } from "@/services/summary";
import { COPY } from "@/constants/copy";
import { logError } from "@/lib/logger";
import { isAbortError } from "@/lib/lifecycle";
import { JournalSidebar } from "./unified-board/JournalSidebar";
import { JournalEntry } from "./unified-board/JournalEntry";
import { RepoPickerDialog } from "@/components/RepoPickerDialog";
import {
  Structure,
  NavigationNode,
  DailyInfo,
} from "./unified-board/types";

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
  const structureControllerRef = useRef<AbortController | null>(null);
  const contentControllerRef = useRef<AbortController | null>(null);
  const [repoPicker, setRepoPicker] = useState<{
    open: boolean;
    date: string;
    repos: string[];
    repo: string;
  }>({ open: false, date: "", repos: [], repo: "" });

  const {
    getYearlySummary,
    getMonthlySummaries,
    getDailySummaries,
    getWeeklySummaries,
    refetchData,
  } = useSummary();

  // Load structure
  useEffect(() => {
    // Year switch: clear view state to avoid mixing years.
    setStructure(null);
    setSelectedNode(null);
    setContent("");
    setRepoPicker({ open: false, date: "", repos: [], repo: "" });

    structureControllerRef.current?.abort();
    const controller = new AbortController();
    structureControllerRef.current = controller;
    fetchStructure(controller.signal);
    return () => {
      controller.abort();
      if (structureControllerRef.current === controller) {
        structureControllerRef.current = null;
      }
    };
  }, [year]);

  // Load content when selection changes
  useEffect(() => {
    if (selectedNode) {
      contentControllerRef.current?.abort();
      const controller = new AbortController();
      contentControllerRef.current = controller;
      loadContent(selectedNode, controller);
      return () => {
        controller.abort();
        if (contentControllerRef.current === controller) {
          contentControllerRef.current = null;
        }
      };
    }
  }, [selectedNode]);

  const fetchStructure = async (signal?: AbortSignal) => {
    try {
      const [yearlyData, monthlyData, dailyData, weeklyData] =
        await Promise.all([
          getYearlySummary(year, { signal }),
          getMonthlySummaries(year, { signal }),
          getDailySummaries(year, { signal }),
          getWeeklySummaries(year, { signal }),
        ]);

      const hasYearlySummary = !!yearlyData?.content;

      // Organize daily data by month (preserve repo info)
      const monthMap = new Map<string, DailyInfo[]>();
      (dailyData || []).forEach((d) => {
        const month = d.date.substring(0, 7);
        if (!monthMap.has(month)) monthMap.set(month, []);
        // Avoid duplicates
        const existing = monthMap.get(month)!;
        if (!existing.some((e) => e.date === d.date && e.repo === d.repo)) {
          existing.push({
            date: d.date,
            repo: d.repo,
            hasSummary: !!d.summary,
          });
        }
      });

      const monthlyByMonth = new Map(
        (monthlyData || []).map((m) => [m.month, m] as const)
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
          .map((w) => ({
            weekStart: w.weekStart,
            weekEnd: w.weekEnd,
            hasSummary: !!w.summary,
            title: COPY.unifiedBoard.weekTitle(getWeekNumber(new Date(w.weekStart))),
          }))
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
      if (isAbortError(error)) return;
      logError("unifiedBoard.fetchStructure", error, { year });
      toast.error(COPY.toasts.boardStructureFailed);
    }
  };

  const loadContent = async (
    node: NavigationNode,
    controller?: AbortController
  ) => {
    const signal = controller?.signal;
    setLoadingContent(true);
    try {
      if (node.type === "yearly") {
        const data = await getYearlySummary(year, { signal });
        setContent(data?.content || "");
      } else if (node.type === "monthly") {
        const data = await getMonthlySummaries(year, { signal });
        const monthData = data.find((m) => m.month === node.id);
        setContent(monthData?.summary || "");
      } else if (node.type === "weekly") {
        const data = await getWeeklySummaries(year, { signal });
        // id is weekStart
        const weekData = data.find((w) => w.weekStart === node.id);
        setContent(weekData?.summary || "");
      } else {
        const data = await getDailySummaries(year, { signal });
        const matches = (data || []).filter((d) => d.date === node.id);
        if (matches.length === 0) {
          setContent("");
          return;
        }

        if (node.repo) {
          const exact = matches.find((d) => d.repo === node.repo);
          setContent(exact?.summary || "");
          return;
        }

        if (matches.length === 1) {
          setSelectedNode((prev) => (prev ? { ...prev, repo: matches[0].repo } : prev));
          setContent(matches[0].summary || "");
          return;
        }

        const options = matches
          .map((d) => d.repo)
          .slice()
          .sort((a: string, b: string) => a.localeCompare(b));

        setRepoPicker({
          open: true,
          date: node.id,
          repos: options,
          repo: options[0] || "",
        });
        setContent("");
      }
    } catch (error) {
      if (isAbortError(error)) return;
      logError("unifiedBoard.loadContent", error, {
        year,
        nodeType: node.type,
        nodeId: node.id,
        repo: node.type === "daily" ? node.repo : undefined,
      });
      toast.error(COPY.toasts.boardContentFailed);
    } finally {
      if (!controller || contentControllerRef.current === controller) {
        setLoadingContent(false);
      }
    }
  };

  const handleRegenerate = async (customPrompt: string) => {
    if (!selectedNode) return;

    // Daily type requires repo
    if (selectedNode.type === "daily" && !selectedNode.repo) {
      toast.error(COPY.toasts.missingDailyRepoForRegeneration);
      return;
    }

    setRegenerating(true);
    try {
      const updated = await regenerateSummary({
        type: selectedNode.type,
        id: selectedNode.id,
        year,
        repo: selectedNode.repo,
        customPrompt,
      });

      toast.success(COPY.toasts.regenerationSuccessful);
      setContent(updated);
      structureControllerRef.current?.abort();
      const controller = new AbortController();
      structureControllerRef.current = controller;
      fetchStructure(controller.signal);
      refetchData();
    } catch (error) {
      logError("unifiedBoard.regenerate", error, {
        year,
        selectedNodeType: selectedNode.type,
        selectedNodeId: selectedNode.id,
        repo: selectedNode.repo,
      });
      const message =
        error instanceof Error
          ? error.message
          : COPY.toasts.networkErrorDuringRegeneration;
      toast.error(message);
    } finally {
      setRegenerating(false);
    }
  };

  if (!structure) {
    return (
      <div className="p-8 text-center text-muted-foreground animate-pulse">
        {COPY.unifiedBoard.loading}
      </div>
    );
  }

  return (
    <>
      <RepoPickerDialog
        open={repoPicker.open}
        onOpenChange={(open) => setRepoPicker((prev) => ({ ...prev, open }))}
        date={repoPicker.date}
        repos={repoPicker.repos}
        repo={repoPicker.repo}
        onRepoChange={(repo) => setRepoPicker((prev) => ({ ...prev, repo }))}
        onConfirm={() => {
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
      />

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
              {COPY.unifiedBoard.empty.title}
            </p>
            <p className="text-sm">
              {COPY.unifiedBoard.empty.description}
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
