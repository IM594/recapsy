import { useState, useEffect, useCallback, useRef } from "react";
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

export const useSummary = () => {
  const [status, setStatus] = useState<SummaryStatus>({
    isRunning: false,
    phase: "idle",
    progress: 0,
    currentStep: null,
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const addLog = (message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [
      { timestamp: new Date().toLocaleTimeString(), message, type },
      ...prev,
    ]);
  };

  const [isConnected, setIsConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Connect to SSE stream
  const connect = useCallback(() => {
    if (eventSourceRef.current) return;

    const year = new Date().getFullYear();
    const es = new EventSource(
      `http://localhost:3456/api/summary/events?year=${year}`
    );

    es.onopen = () => {
      setIsConnected(true);
      console.log("SSE Connected");
    };

    es.onerror = (err) => {
      console.error("SSE Error:", err);
      setIsConnected(false);
      // Optional: Retry logic could go here, but EventSource auto-retries usually
    };

    es.addEventListener("status", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      setStatus(data);
    });

    es.addEventListener("progress", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      // Update local state partially
      setStatus((prev) => ({
        ...prev,
        currentStep: data.step,
        progress: data.progress,
        isRunning: true,
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
    });

    es.addEventListener("error", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      toast.error(`Error: ${data.message}`);
      addLog(`Error: ${data.message}`, "error");
      setStatus((prev) => ({ ...prev, isRunning: false, phase: "error" }));
    });

    eventSourceRef.current = es;
  }, []);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      setIsConnected(false);
    }
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  const startGeneration = async (config: GenerationConfig) => {
    try {
      const res = await fetch("http://localhost:3456/api/summary/generate", {
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
          // Use the status returned from backend
          if (err.status) setStatus(err.status);
          return;
        }
        throw new Error(err.error || "Failed to start generation");
      }

      setStatus((prev) => ({ ...prev, isRunning: true, phase: "starting" }));
      setLogs([]); // Clear logs on start
      addLog("Started background generation task...", "info");
      toast.info("Started background generation task...");
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const getYearlySummary = async (year?: number) => {
    const y = year || new Date().getFullYear();
    const res = await fetch(
      `http://localhost:3456/api/summary/data?type=yearly&year=${y}`
    );
    return res.json();
  };

  const getDailySummaries = async (year?: number) => {
    const y = year || new Date().getFullYear();
    const res = await fetch(
      `http://localhost:3456/api/summary/data?type=daily&year=${y}`
    );
    return res.json();
  };

  const getMonthlySummaries = async (year?: number) => {
    const y = year || new Date().getFullYear();
    const res = await fetch(
      `http://localhost:3456/api/summary/data?type=monthly&year=${y}`
    );
    return res.json();
  };

  return {
    status,
    logs,
    isConnected,
    startGeneration,
    getYearlySummary,
    getDailySummaries,
    getMonthlySummaries,
  };
};
