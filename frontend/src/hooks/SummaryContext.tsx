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
import { getSummaryApiUrl } from "@/lib/api";
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
  WeeklySummaryData,
  YearlySummaryData,
} from "@/types/summary";

export type { GenerationConfig, LogEntry, SSEEvent, SummaryStatus, SummaryType };

const DEBUG_SSE = (() => {
  const value = import.meta.env.VITE_DEBUG_SSE;
  return value === "1" || value === "true";
})();

function debugSse(...args: unknown[]) {
  if (DEBUG_SSE) console.log(...args);
}

function safeJsonParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
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

    const es = new EventSource(getSummaryApiUrl(`/events?year=${year}`));

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
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          connect();
        }, 3000);
      }
    };

    // Handle status event with new format: { nodeId, state, timestamp }
    es.addEventListener("status", (e: MessageEvent) => {
      debugSse("[SSE] status event:", e.data);
      const data = safeJsonParse(e.data);
      if (!data) return;
      // New format: { nodeId, state: { progress, currentStep, phase, isRunning }, timestamp }
      if ((data as any).state) {
        setStatus({
          isRunning: (data as any).state.isRunning ?? false,
          phase: (data as any).state.phase ?? "idle",
          progress: (data as any).state.progress ?? 0,
          currentStep: (data as any).state.currentStep ?? null,
        });
      } else {
        // Fallback for old format
        setStatus(data as any);
      }
    });

    // Handle progress event with new format
    es.addEventListener("progress", (e: MessageEvent) => {
      debugSse("[SSE] progress event:", e.data);
      const data = safeJsonParse(e.data);
      if (!data) return;
      // New format: { nodeId, state: { progress, currentStep, message }, timestamp }
      const nodeId = (data as any).nodeId;
      const state = (data as any).state || data; // Fallback for old format

      setStatus((prev) => ({
        ...prev,
        currentStep: state.currentStep || nodeId || prev.currentStep,
        progress: state.progress ?? prev.progress,
        isRunning: true,
        phase: state.phase || prev.phase,
      }));

      const message = state.message || `Completed: ${nodeId}`;
      addLog(message, "info");
    });

    // Handle complete event with new format
    es.addEventListener("complete", (e: MessageEvent) => {
      debugSse("[SSE] complete event:", e.data);
      const data = safeJsonParse(e.data);
      if (!data) return;
      // New format: { nodeId, state: { progress, currentStep, result }, timestamp }
      const state = (data as any).state || data;

      setStatus((prev) => ({
        ...prev,
        isRunning: false,
        phase: "complete",
        progress: 100,
        currentStep: null,
        result: state.result || data,
      }));
      addLog("Summary generation completed!", "success");
      toast.success("Summary generation completed!");
      setDataVersion((v) => v + 1);
    });

    // Handle workflow_error event with new format
    es.addEventListener("workflow_error", (e: MessageEvent) => {
      debugSse("[SSE] workflow_error event:", e.data);
      const data = safeJsonParse(e.data);
      if (!data) return;
      // New format: { nodeId, state: { error }, timestamp }
      const errorMessage =
        (data as any).state?.error || (data as any).message || "Unknown error";

      toast.error(`Error: ${errorMessage}`);
      addLog(`Error: ${errorMessage}`, "error");
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
          toast.warning("A task is already running.");
          setStatus(result.status);
          return;
        }

        setStatus((prev) => ({ ...prev, isRunning: true, phase: "starting" }));
        setLogs([]);
        addLog("Started background generation task...", "info");
        toast.info("Started background generation task...");
      } catch (error) {
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
    } catch {
      // Keep UI stable even if reset fails; callers can show toasts if needed.
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
