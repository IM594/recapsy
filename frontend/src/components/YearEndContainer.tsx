import { useState, useEffect } from "react";
import { YearEndGenerator } from "./YearEndGenerator";
import { UnifiedBoard } from "./UnifiedBoard";
import { Loader2 } from "lucide-react";
import { getSummaryApiUrl } from "@/lib/api";

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

  // Check running status on mount and poll
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const statusRes = await fetch(
          getSummaryApiUrl(`/status?year=${year}`)
        );
        if (statusRes.ok) {
          const status = await statusRes.json();
          setIsRunning(status.isRunning);
        }
      } catch (error) {
        console.error("Failed to check status", error);
      } finally {
        setChecking(false);
      }
    };

    checkStatus();
    const interval = setInterval(checkStatus, 2000);
    return () => clearInterval(interval);
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
