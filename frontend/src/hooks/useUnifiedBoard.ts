import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { COPY } from "@/constants/copy";
import { isAbortError } from "@/lib/lifecycle";
import { logError } from "@/lib/logger";
import { useSummary } from "@/hooks/useSummary";
import { regenerateSummary } from "@/services/summary";
import { getIsoWeekNumber, SUMMARY_TYPES } from "@recaply/shared";

import type {
  DailyInfo,
  NavigationNode,
  Structure,
} from "@/components/unified-board/types";

export type RepoPickerState = {
  open: boolean;
  date: string;
  repos: string[];
  repo: string;
};

const DEFAULT_REPO_PICKER: RepoPickerState = {
  open: false,
  date: "",
  repos: [],
  repo: "",
};

export function useUnifiedBoard(year: number) {
  const [structure, setStructure] = useState<Structure | null>(null);
  const [selectedNode, setSelectedNode] = useState<NavigationNode | null>(null);
  const [content, setContent] = useState<string>("");
  const [loadingContent, setLoadingContent] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [repoPicker, setRepoPicker] = useState<RepoPickerState>(DEFAULT_REPO_PICKER);

  const structureControllerRef = useRef<AbortController | null>(null);
  const contentControllerRef = useRef<AbortController | null>(null);
  const skipNextContentLoadRef = useRef(false);

  const {
    getYearlySummary,
    getMonthlySummaries,
    getDailySummaries,
    getWeeklySummaries,
    refetchData,
  } = useSummary();

  const fetchStructure = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [yearlyData, monthlyData, dailyData, weeklyData] =
          await Promise.all([
            getYearlySummary(year, { signal }),
            getMonthlySummaries(year, { signal }),
            getDailySummaries(year, { signal }),
            getWeeklySummaries(year, { signal }),
          ]);

        const hasYearlySummary = Boolean(yearlyData?.content);

        const monthMap = new Map<string, DailyInfo[]>();
        (dailyData || []).forEach((d) => {
          const month = d.date.substring(0, 7);
          if (!monthMap.has(month)) monthMap.set(month, []);

          const existing = monthMap.get(month)!;
          if (!existing.some((e) => e.date === d.date && e.repo === d.repo)) {
            existing.push({
              date: d.date,
              repo: d.repo,
              hasSummary: Boolean(d.summary),
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

        const next: Structure = {
          year,
          hasYearlySummary,
          months: months.map((month) => ({
            month,
            hasSummary: Boolean(monthlyByMonth.get(month)?.summary),
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
              hasSummary: Boolean(w.summary),
              title: COPY.unifiedBoard.weekTitle(
                getIsoWeekNumber(w.weekStart)
              ),
            }))
            .sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
        };

        setStructure(next);
      } catch (error) {
        if (isAbortError(error)) return;
        logError("unifiedBoard.fetchStructure", error, { year });
        toast.error(COPY.toasts.boardStructureFailed);
      }
    },
    [getDailySummaries, getMonthlySummaries, getWeeklySummaries, getYearlySummary, year]
  );

  useEffect(() => {
    // Year switch: clear view state to avoid mixing years.
    setStructure(null);
    setSelectedNode(null);
    setContent("");
    setRepoPicker(DEFAULT_REPO_PICKER);

    structureControllerRef.current?.abort();
    const controller = new AbortController();
    structureControllerRef.current = controller;
    void fetchStructure(controller.signal);

    return () => {
      structureControllerRef.current?.abort();
      structureControllerRef.current = null;
    };
  }, [fetchStructure, year]);

  const loadContent = useCallback(
    async (node: NavigationNode, controller?: AbortController) => {
      const signal = controller?.signal;
      setLoadingContent(true);

      try {
        if (node.type === SUMMARY_TYPES.yearly) {
          const data = await getYearlySummary(year, { signal });
          setContent(data?.content || "");
          return;
        }

        if (node.type === SUMMARY_TYPES.monthly) {
          const data = await getMonthlySummaries(year, { signal });
          const monthData = data.find((m) => m.month === node.id);
          setContent(monthData?.summary || "");
          return;
        }

        if (node.type === SUMMARY_TYPES.weekly) {
          const data = await getWeeklySummaries(year, { signal });
          const weekData = data.find((w) => w.weekStart === node.id);
          setContent(weekData?.summary || "");
          return;
        }

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
          skipNextContentLoadRef.current = true;
          setSelectedNode((prev) => {
            if (!prev || prev.type !== SUMMARY_TYPES.daily || prev.id !== node.id) return prev;
            return { ...prev, repo: matches[0].repo };
          });
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
      } catch (error) {
        if (isAbortError(error)) return;
        logError("unifiedBoard.loadContent", error, {
          year,
          nodeType: node.type,
          nodeId: node.id,
          repo: node.type === SUMMARY_TYPES.daily ? node.repo : undefined,
        });
        toast.error(COPY.toasts.boardContentFailed);
      } finally {
        if (!controller || contentControllerRef.current === controller) {
          setLoadingContent(false);
        }
      }
    },
    [getDailySummaries, getMonthlySummaries, getWeeklySummaries, getYearlySummary, year]
  );

  useEffect(() => {
    if (!selectedNode) return;
    if (skipNextContentLoadRef.current) {
      skipNextContentLoadRef.current = false;
      return;
    }

    contentControllerRef.current?.abort();
    const controller = new AbortController();
    contentControllerRef.current = controller;
    void loadContent(selectedNode, controller);
    return () => {
      controller.abort();
      if (contentControllerRef.current === controller) {
        contentControllerRef.current = null;
      }
    };
  }, [loadContent, selectedNode]);

  const setRepoPickerOpen = useCallback((open: boolean) => {
    setRepoPicker((prev) => ({ ...prev, open }));
  }, []);

  const setRepoPickerRepo = useCallback((repo: string) => {
    setRepoPicker((prev) => ({ ...prev, repo }));
  }, []);

  const confirmRepoPicker = useCallback(() => {
    setSelectedNode((prev) => {
      if (!prev || prev.type !== SUMMARY_TYPES.daily || prev.id !== repoPicker.date) {
        return prev;
      }
      return { ...prev, repo: repoPicker.repo || prev.repo };
    });
    setRepoPicker((prev) => ({ ...prev, open: false }));
  }, [repoPicker.date, repoPicker.repo]);

  const regenerate = useCallback(
    async (customPrompt: string) => {
      if (!selectedNode) return;

      if (selectedNode.type === SUMMARY_TYPES.daily && !selectedNode.repo) {
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
        void fetchStructure(controller.signal);

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
    },
    [fetchStructure, refetchData, selectedNode, year]
  );

  return {
    structure,
    selectedNode,
    setSelectedNode,
    content,
    loadingContent,
    regenerating,
    regenerate,
    repoPicker,
    setRepoPickerOpen,
    setRepoPickerRepo,
    confirmRepoPicker,
  };
}
