import { useState, useEffect } from "react";
import { YearEndGenerator } from "./YearEndGenerator";
import { YearEndReview } from "./YearEndReview";
import { Loader2 } from "lucide-react";

interface YearEndContainerProps {
  initialYear?: number;
  forcedMode?: "view" | "regenerate";
}

import { useSummary } from "../hooks/useSummary";

export function YearEndContainer({
  initialYear = 2025,
  forcedMode = "view",
}: YearEndContainerProps) {
  const [view, setView] = useState<"loading" | "generator" | "review">(
    "loading"
  );
  const [year] = useState(initialYear);
  const { getYearlySummary } = useSummary();

  // Check data on mount to decide view
  useEffect(() => {
    if (forcedMode === "regenerate") {
      setView("generator");
    } else {
      checkData();
    }
  }, [year, forcedMode]);

  const checkData = async () => {
    try {
      const data = await getYearlySummary(year);
      if (data && data.content) {
        setView("review");
      } else {
        setView("generator");
      }
    } catch (error) {
      console.error("Failed to check existing data", error);
      setView("generator");
    }
  };

  const handleGenerationComplete = () => {
    setView("review");
  };

  if (view === "loading") {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-slate-300" />
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-300">
      {view === "generator" && (
        <YearEndGenerator onComplete={handleGenerationComplete} year={year} />
      )}

      {view === "review" && <YearEndReview year={year} />}
    </div>
  );
}
