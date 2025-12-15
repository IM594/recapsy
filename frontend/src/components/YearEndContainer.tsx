import { useState, useEffect } from "react";
import { YearEndGenerator } from "./YearEndGenerator";
import { YearEndReview } from "./YearEndReview";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

interface YearEndContainerProps {
  initialYear?: number;
}

export function YearEndContainer({
  initialYear = 2025,
}: YearEndContainerProps) {
  const [view, setView] = useState<"generator" | "review">("generator");
  const [, setHasData] = useState(false); // Can be used for initial state if needed
  const [year] = useState(initialYear);

  // Check if data exists on mount
  useEffect(() => {
    checkData();
  }, [year]);

  const checkData = async () => {
    try {
      const res = await fetch(
        `http://localhost:3456/api/year-end/structure?year=${year}`
      );
      const data = await res.json();
      if (data.structure && data.structure.hasYearlySummary) {
        setHasData(true);
        setView("review");
      }
    } catch (error) {
      console.error("Failed to check existing data", error);
    }
  };

  const handleGenerationComplete = () => {
    setHasData(true);
    setView("review");
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center mb-6">
        {view === "review" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setView("generator")}
            className="gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Start New Review
          </Button>
        )}
      </div>

      {view === "generator" ? (
        <YearEndGenerator onComplete={handleGenerationComplete} year={year} />
      ) : (
        <YearEndReview year={year} />
      )}
    </div>
  );
}
