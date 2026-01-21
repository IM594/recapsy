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

export interface SummaryStatus {
  isRunning: boolean;
  phase: string;
  progress: number;
  currentStep: string | null;
  result?: any;
}

export type SummaryType = "daily" | "weekly" | "monthly" | "yearly";

export interface GenerationConfig {
  selectedRepos: string[];
  since: string;
  until: string;
  summaryType: SummaryType;
  year: number;
  author?: string;
}

export interface LogEntry {
  timestamp: string;
  message: string;
  type: "info" | "error" | "success";
}

/**
 * New SSE event format from LangGraph streaming
 */
export interface SSEEvent {
  nodeId: string;
  state: {
    progress?: number;
    currentStep?: string;
    phase?: string;
    isRunning?: boolean;
    message?: string;
    result?: any;
    error?: string;
  };
  timestamp: number;
}

interface SummaryContextType {
  status: SummaryStatus;
  logs: LogEntry[];
  isConnected: boolean;
  dataVersion: number;
  startGeneration: (config: GenerationConfig) => Promise<void>;
  getYearlySummary: (year?: number) => Promise<any>;
  getDailySummaries: (year?: number) => Promise<any>;
  getWeeklySummaries: (year?: number) => Promise<any>;
  getMonthlySummaries: (year?: number) => Promise<any>;
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
      console.log("[SSE] status event:", e.data);
      const data = JSON.parse(e.data);
      // New format: { nodeId, state: { progress, currentStep, phase, isRunning }, timestamp }
      if (data.state) {
        setStatus({
          isRunning: data.state.isRunning ?? false,
          phase: data.state.phase ?? "idle",
          progress: data.state.progress ?? 0,
          currentStep: data.state.currentStep ?? null,
        });
      } else {
        // Fallback for old format
        setStatus(data);
      }
    });

    // Handle progress event with new format
    es.addEventListener("progress", (e: MessageEvent) => {
      console.log("[SSE] progress event:", e.data);
      const data = JSON.parse(e.data);
      // New format: { nodeId, state: { progress, currentStep, message }, timestamp }
      const nodeId = data.nodeId;
      const state = data.state || data; // Fallback for old format

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
      console.log("[SSE] complete event:", e.data);
      const data = JSON.parse(e.data);
      // New format: { nodeId, state: { progress, currentStep, result }, timestamp }
      const state = data.state || data;

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
      console.error("[SSE] workflow_error event:", e.data);
      const data = JSON.parse(e.data);
      // New format: { nodeId, state: { error }, timestamp }
      const errorMessage = data.state?.error || data.message || "Unknown error";

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
        const res = await fetch(getSummaryApiUrl("/generate"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...config,
            author: config.author || "",
          }),
        });

        if (!res.ok) {
          const err = await res.json();
          if (res.status === 409) {
            toast.warning("A task is already running.");
            if (err.status) setStatus(err.status);
            return;
          }
          throw new Error(err.error || "Failed to start generation");
        }

        setStatus((prev) => ({ ...prev, isRunning: true, phase: "starting" }));
        setLogs([]);
        addLog("Started background generation task...", "info");
        toast.info("Started background generation task...");
      } catch (error: any) {
        toast.error(error.message);
      }
    },
    [addLog]
  );

  const getYearlySummary = useCallback(async (requestedYear?: number) => {
    const y = requestedYear ?? year;
    const res = await fetch(getSummaryApiUrl(`/data?type=yearly&year=${y}`));
    return res.json();
  }, [year]);

  const getDailySummaries = useCallback(async (requestedYear?: number) => {
    const y = requestedYear ?? year;
    const res = await fetch(getSummaryApiUrl(`/data?type=daily&year=${y}`));
    return res.json();
  }, [year]);

  const getMonthlySummaries = useCallback(async (requestedYear?: number) => {
    const y = requestedYear ?? year;
    const res = await fetch(getSummaryApiUrl(`/data?type=monthly&year=${y}`));
    return res.json();
  }, [year]);

  const getWeeklySummaries = useCallback(async (requestedYear?: number) => {
    const y = requestedYear ?? year;
    const res = await fetch(getSummaryApiUrl(`/data?type=weekly&year=${y}`));
    return res.json();
  }, [year]);

  const resetStatus = useCallback(async (requestedYear?: number) => {
    const y = requestedYear ?? year;
    const res = await fetch(getSummaryApiUrl("/reset"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year: y }),
    });
    if (res.ok) {
      const data = await res.json();
      setStatus(data.status);
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
