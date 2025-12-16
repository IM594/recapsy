import { useState, useEffect } from "react";
import { YearEndGenerator } from "./YearEndGenerator";
import { YearEndReview } from "./YearEndReview";
import { YearEndLanding } from "./YearEndLanding";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

interface YearEndContainerProps {
  initialYear?: number;
}

export function YearEndContainer({
  initialYear = 2025,
}: YearEndContainerProps) {
  const [view, setView] = useState<"landing" | "generator" | "review">(
    "landing"
  );
  const [hasData, setHasData] = useState(false);
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
        // Removed auto-redirect to 'review' based on user feedback
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
      {/* Navigation Header only for non-landing pages */}
      {view !== "landing" && (
        <div className="flex justify-between items-center mb-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setView("landing")}
            className="gap-2 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Dashboard
          </Button>
        </div>
      )}

      {view === "landing" && (
        <YearEndLanding
          year={year}
          hasData={hasData}
          onStartNew={() => setView("generator")}
          onViewReport={() => setView("review")}
        />
      )}

      {view === "generator" && (
        <YearEndGenerator onComplete={handleGenerationComplete} year={year} />
      )}

      {view === "review" && <YearEndReview year={year} />}
    </div>
  );
}
