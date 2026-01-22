import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  ReactNode,
} from "react";
import { toast } from "sonner";
import { COPY } from "@/constants/copy";
import { SSE_EVENTS, SUMMARY_ROUTES } from "@recaply/shared";
import { getSummaryApiUrl } from "@/lib/api";
import { logDebug, logError, logWarn } from "@/lib/logger";
import {
  fetchDailySummaries,
  fetchMonthlySummaries,
  fetchWeeklySummaries,
  fetchYearlySummary,
  resetSummaryStatus,
  startSummaryGeneration,
} from "@/services/summary";

import type {
  DailySummaryData,
  GenerationConfig,
  LogEntry,
  MonthlySummaryData,
  SSEEvent,
  SummaryStatus,
  SummaryType,
  SummaryPhase,
  WeeklySummaryData,
  YearlySummaryData,
} from "@/types/summary";

export type { GenerationConfig, LogEntry, SSEEvent, SummaryStatus, SummaryType };

const DEBUG_SSE = (() => {
  const value = import.meta.env.VITE_DEBUG_SSE;
  return value === "1" || value === "true";
})();

function debugSse(...args: unknown[]) {
  if (DEBUG_SSE) logDebug("sse", ...args);
}

function safeJsonParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (DEBUG_SSE) logError("sse.safeJsonParse", error, { rawPreview: raw.slice(0, 120) });
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSummaryPhase(value: unknown): value is SummaryPhase {
  return (
    value === "idle" ||
    value === "starting" ||
    value === "running" ||
    value === "complete" ||
    value === "error"
  );
}

function parseSseEvent(value: unknown): SSEEvent | null {
  if (!isRecord(value)) return null;

  const nodeId = value.nodeId;
  const timestamp = value.timestamp;
  const state = value.state;

  if (typeof nodeId !== "string" || !nodeId.trim()) return null;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  if (!isRecord(state)) return null;

  const parsed: SSEEvent = {
    nodeId,
    timestamp,
    state: {},
  };

  if (typeof state.progress === "number" && Number.isFinite(state.progress)) {
    parsed.state.progress = state.progress;
  }
  if (typeof state.currentStep === "string" && state.currentStep.trim()) {
    parsed.state.currentStep = state.currentStep;
  }
  if (isSummaryPhase(state.phase)) parsed.state.phase = state.phase;
  if (typeof state.isRunning === "boolean") parsed.state.isRunning = state.isRunning;
  if (typeof state.message === "string" && state.message.trim()) {
    parsed.state.message = state.message;
  }
  if (typeof state.error === "string" && state.error.trim()) {
    parsed.state.error = state.error;
  }
  if (state.result !== undefined) parsed.state.result = state.result;

  return parsed;
}

function parseSummaryStatus(value: unknown): SummaryStatus | null {
  if (!isRecord(value)) return null;

  const isRunning = value.isRunning;
  const phase = value.phase;
  const progress = value.progress;
  const currentStep = value.currentStep;

  if (typeof isRunning !== "boolean") return null;
  if (!isSummaryPhase(phase)) return null;
  if (typeof progress !== "number" || !Number.isFinite(progress)) return null;
  if (!(typeof currentStep === "string" || currentStep === null)) return null;

  return {
    isRunning,
    phase,
    progress,
    currentStep,
    result: value.result,
  };
}

interface SummaryContextType {
  status: SummaryStatus;
  logs: LogEntry[];
  isConnected: boolean;
  dataVersion: number;
  startGeneration: (config: GenerationConfig) => Promise<void>;
  getYearlySummary: (year?: number) => Promise<YearlySummaryData>;
  getDailySummaries: (year?: number) => Promise<DailySummaryData[]>;
  getWeeklySummaries: (year?: number) => Promise<WeeklySummaryData[]>;
  getMonthlySummaries: (year?: number) => Promise<MonthlySummaryData[]>;
  resetStatus: (year?: number) => Promise<void>;
  refetchData: () => void;
}

const SummaryContext = createContext<SummaryContextType | null>(null);

export function SummaryProvider({
  children,
  year,
}: {
  children: ReactNode;
  year: number;
}) {
  const [status, setStatus] = useState<SummaryStatus>({
    isRunning: false,
    phase: "idle",
    progress: 0,
    currentStep: null,
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const addLog = useCallback(
    (message: string, type: LogEntry["type"] = "info") => {
      setLogs((prev) => [
        { timestamp: new Date().toLocaleTimeString(), message, type },
        ...prev.slice(0, 99), // Keep last 100 logs
      ]);
    },
    []
  );

  const connect = useCallback(() => {
    if (eventSourceRef.current) return;

    const es = new EventSource(
      getSummaryApiUrl(`${SUMMARY_ROUTES.events}?year=${year}`)
    );

    es.onopen = () => {
      setIsConnected(true);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    es.onerror = () => {
      setIsConnected(false);
      es.close();
      eventSourceRef.current = null;

      // Reconnect after delay
      if (!reconnectTimeoutRef.current) {
        if (DEBUG_SSE) logWarn("sse.connection", "connection error; scheduling reconnect", { year });
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          connect();
        }, 3000);
      }
    };

    // Handle status event with new format: { nodeId, state, timestamp }
    es.addEventListener(SSE_EVENTS.status, (e: MessageEvent) => {
      debugSse("[SSE] status event:", e.data);
      const data = safeJsonParse(e.data);
      if (!data) return;

      const event = parseSseEvent(data);
      if (event) {
        setStatus({
          isRunning: event.state.isRunning ?? false,
          phase: event.state.phase ?? "idle",
          progress: event.state.progress ?? 0,
          currentStep: event.state.currentStep ?? null,
        });
        return;
      }

      const fallback = parseSummaryStatus(data);
      if (fallback) setStatus(fallback);
    });

    // Handle progress event with new format
    es.addEventListener(SSE_EVENTS.progress, (e: MessageEvent) => {
      debugSse("[SSE] progress event:", e.data);
      const data = safeJsonParse(e.data);
      if (!data) return;

      const event = parseSseEvent(data);
      if (!event) return;

      setStatus((prev) => ({
        ...prev,
        currentStep: event.state.currentStep || event.nodeId || prev.currentStep,
        progress: event.state.progress ?? prev.progress,
        isRunning: true,
        phase: event.state.phase || prev.phase,
      }));

      const message = event.state.message || `Completed: ${event.nodeId}`;
      addLog(message, "info");
    });

    // Handle complete event with new format
    es.addEventListener(SSE_EVENTS.complete, (e: MessageEvent) => {
      debugSse("[SSE] complete event:", e.data);
      const data = safeJsonParse(e.data);
      if (!data) return;

      const event = parseSseEvent(data);
      if (!event) return;

      setStatus((prev) => ({
        ...prev,
        isRunning: false,
        phase: "complete",
        progress: 100,
        currentStep: null,
        result: event.state.result ?? data,
      }));
      addLog(COPY.toasts.generationCompleted, "success");
      toast.success(COPY.toasts.generationCompleted);
      setDataVersion((v) => v + 1);
    });

    // Handle workflow_error event with new format
    es.addEventListener(SSE_EVENTS.workflowError, (e: MessageEvent) => {
      debugSse("[SSE] workflow_error event:", e.data);
      const data = safeJsonParse(e.data);
      if (!data) return;

      const event = parseSseEvent(data);
      if (!event) return;

      const errorMessage = event.state.error || "Unknown error";

      toast.error(`${COPY.toasts.workflowErrorPrefix} ${errorMessage}`);
      addLog(`${COPY.toasts.workflowErrorPrefix} ${errorMessage}`, "error");
      setStatus((prev) => ({ ...prev, isRunning: false, phase: "error" }));
    });

    eventSourceRef.current = es;
  }, [addLog, year]);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      setIsConnected(false);
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  // When switching years, clear UI state to avoid mixing years.
  useEffect(() => {
    setLogs([]);
    setStatus({
      isRunning: false,
      phase: "idle",
      progress: 0,
      currentStep: null,
    });
  }, [year]);

  const startGeneration = useCallback(
    async (config: GenerationConfig) => {
      try {
        const result = await startSummaryGeneration(config);
        if (result.kind === "already_running") {
          toast.warning(COPY.toasts.taskAlreadyRunning);
          setStatus(result.status);
          return;
        }

        setStatus((prev) => ({ ...prev, isRunning: true, phase: "starting" }));
        setLogs([]);
        addLog(COPY.toasts.startedGenerationTask, "info");
        toast.info(COPY.toasts.startedGenerationTask);
      } catch (error) {
        logError("summary.startGeneration", error, {
          year: config.year,
          summaryType: config.summaryType,
          hasSince: Boolean(config.since),
          hasUntil: Boolean(config.until),
          selectedReposCount: config.selectedRepos?.length ?? 0,
        });
        const message =
          error instanceof Error ? error.message : "Failed to start generation";
        toast.error(message);
      }
    },
    [addLog]
  );

  const getYearlySummary = useCallback(async (requestedYear?: number) => {
    const y = requestedYear ?? year;
    return fetchYearlySummary(y);
  }, [year]);

  const getDailySummaries = useCallback(async (requestedYear?: number) => {
    const y = requestedYear ?? year;
    return fetchDailySummaries(y);
  }, [year]);

  const getMonthlySummaries = useCallback(async (requestedYear?: number) => {
    const y = requestedYear ?? year;
    return fetchMonthlySummaries(y);
  }, [year]);

  const getWeeklySummaries = useCallback(async (requestedYear?: number) => {
    const y = requestedYear ?? year;
    return fetchWeeklySummaries(y);
  }, [year]);

  const resetStatus = useCallback(async (requestedYear?: number) => {
    const y = requestedYear ?? year;
    try {
      const next = await resetSummaryStatus(y);
      setStatus(next);
    } catch (error) {
      // Keep UI stable even if reset fails; callers can show toasts if needed.
      logError("summary.resetStatus", error, { year: y });
    }
  }, [year]);

  const refetchData = useCallback(() => {
    setDataVersion((v) => v + 1);
  }, []);

  return (
    <SummaryContext.Provider
      value={{
        status,
        logs,
        isConnected,
        dataVersion,
        startGeneration,
        getYearlySummary,
        getDailySummaries,
        getWeeklySummaries,
        getMonthlySummaries,
        resetStatus,
        refetchData,
      }}
    >
      {children}
    </SummaryContext.Provider>
  );
}

export function useSummaryContext() {
  const context = useContext(SummaryContext);
  if (!context) {
    throw new Error("useSummaryContext must be used within SummaryProvider");
  }
  return context;
}
