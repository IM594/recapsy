import { useState, useEffect, useRef } from "react";
import { YearEndGenerator } from "./YearEndGenerator";
import { UnifiedBoard } from "./UnifiedBoard";
import { Loader2 } from "lucide-react";
import { fetchSummaryStatus } from "@/services/summary";
import { logError } from "@/lib/logger";
import { isAbortError } from "@/lib/lifecycle";

interface YearEndContainerProps {
  initialYear?: number;
  forcedMode?: "view" | "regenerate";
}

export function YearEndContainer({
  initialYear = new Date().getFullYear(),
  forcedMode = "view",
}: YearEndContainerProps) {
  const year = initialYear;
  const [isRunning, setIsRunning] = useState(false);
  const [checking, setChecking] = useState(true);
  const statusControllerRef = useRef<AbortController | null>(null);

  // Check running status on mount and poll
  useEffect(() => {
    const checkStatus = async () => {
      statusControllerRef.current?.abort();
      const controller = new AbortController();
      statusControllerRef.current = controller;

      try {
        const status = await fetchSummaryStatus(year, { signal: controller.signal });
        setIsRunning(!!status.isRunning);
      } catch (error) {
        if (isAbortError(error)) return;
        logError("yearEnd.checkStatus", error, { year });
      } finally {
        setChecking(false);
      }
    };

    void checkStatus();
    const interval = setInterval(() => {
      void checkStatus();
    }, 2000);
    return () => {
      clearInterval(interval);
      statusControllerRef.current?.abort();
      statusControllerRef.current = null;
    };
  }, [year]);

  const handleGenerationComplete = () => {
    setIsRunning(false);
  };

  if (checking) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-slate-300" />
      </div>
    );
  }

  if (isRunning) {
    return (
      <div className="animate-in fade-in duration-300">
        <YearEndGenerator
          onComplete={handleGenerationComplete}
          year={year}
          shouldResetCheckpoint={false}
        />
      </div>
    );
  }

  if (forcedMode === "regenerate") {
    return (
      <div className="animate-in fade-in duration-300">
        <YearEndGenerator
          onComplete={handleGenerationComplete}
          year={year}
          shouldResetCheckpoint={true}
        />
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-300">
      <UnifiedBoard year={year} />
    </div>
  );
}
