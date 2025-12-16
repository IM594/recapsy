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

export interface SummaryStatus {
  isRunning: boolean;
  phase: string;
  progress: number;
  currentStep: string | null;
  result?: any;
}

export interface GenerationConfig {
  selectedRepos: string[];
  since: string;
  until: string;
  summaryType: string;
  author?: string;
}

export interface LogEntry {
  timestamp: string;
  message: string;
  type: "info" | "error" | "success";
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

const API_BASE = "http://localhost:3456/api/summary";

export function SummaryProvider({ children }: { children: ReactNode }) {
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

    const year = new Date().getFullYear();
    const es = new EventSource(`${API_BASE}/events?year=${year}`);

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

    es.addEventListener("status", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      setStatus(data);
    });

    es.addEventListener("progress", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      setStatus((prev) => ({
        ...prev,
        currentStep: data.step,
        progress: data.progress,
        isRunning: true,
        phase: data.phase || prev.phase,
      }));
      if (data.message) addLog(data.message, "info");
    });

    es.addEventListener("complete", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      setStatus((prev) => ({
        ...prev,
        isRunning: false,
        phase: "complete",
        progress: 100,
        currentStep: null,
        result: data,
      }));
      addLog("Summary generation completed!", "success");
      toast.success("Summary generation completed!");
      setDataVersion((v) => v + 1);
    });

    // Use "workflow_error" to avoid conflict with EventSource built-in "error" event
    es.addEventListener("workflow_error", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      toast.error(`Error: ${data.message}`);
      addLog(`Error: ${data.message}`, "error");
      setStatus((prev) => ({ ...prev, isRunning: false, phase: "error" }));
    });

    eventSourceRef.current = es;
  }, [addLog]);

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

  const startGeneration = useCallback(
    async (config: GenerationConfig) => {
      try {
        const res = await fetch(`${API_BASE}/generate`, {
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

  const getYearlySummary = useCallback(async (year?: number) => {
    const y = year || new Date().getFullYear();
    const res = await fetch(`${API_BASE}/data?type=yearly&year=${y}`);
    return res.json();
  }, []);

  const getDailySummaries = useCallback(async (year?: number) => {
    const y = year || new Date().getFullYear();
    const res = await fetch(`${API_BASE}/data?type=daily&year=${y}`);
    return res.json();
  }, []);

  const getMonthlySummaries = useCallback(async (year?: number) => {
    const y = year || new Date().getFullYear();
    const res = await fetch(`${API_BASE}/data?type=monthly&year=${y}`);
    return res.json();
  }, []);

  const getWeeklySummaries = useCallback(async (year?: number) => {
    const y = year || new Date().getFullYear();
    const res = await fetch(`${API_BASE}/data?type=weekly&year=${y}`);
    return res.json();
  }, []);

  const resetStatus = useCallback(async (year?: number) => {
    const y = year || new Date().getFullYear();
    const res = await fetch(`${API_BASE}/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year: y }),
    });
    if (res.ok) {
      const data = await res.json();
      setStatus(data.status);
    }
  }, []);

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
