import { useState, useEffect } from "react";
import { YearEndGenerator } from "./YearEndGenerator";
import { YearEndReview } from "./YearEndReview";
import { GenerationPreview } from "./GenerationPreview";
import { Loader2 } from "lucide-react";
import { useSummary } from "../hooks/useSummary";
import { useSettings } from "../hooks/useSettings";

interface YearEndContainerProps {
  initialYear?: number;
  forcedMode?: "view" | "regenerate";
}

export function YearEndContainer({
  initialYear = 2025,
  forcedMode = "view",
}: YearEndContainerProps) {
  const [view, setView] = useState<
    "loading" | "preview" | "generator" | "review"
  >("loading");
  const [year] = useState(initialYear);
  const [shouldResetCheckpoint, setShouldResetCheckpoint] = useState(false);
  const { getYearlySummary } = useSummary();
  const { selectedRepos, author } = useSettings();

  // Check data on mount to decide view
  useEffect(() => {
    const initView = async () => {
      // First check if task is running
      try {
        const statusRes = await fetch(
          `http://localhost:3456/api/summary/status?year=${year}`
        );
        if (statusRes.ok) {
          const status = await statusRes.json();
          if (status.isRunning) {
            // Task is running, show generator directly
            setView("generator");
            setShouldResetCheckpoint(false);
            return;
          }
        }
      } catch (error) {
        console.error("Failed to check status", error);
      }

      // No task running, proceed with normal logic
      if (forcedMode === "regenerate") {
        setView("preview");
        setShouldResetCheckpoint(true);
      } else {
        checkData();
      }
    };

    initView();
  }, [year, forcedMode]);

  const checkData = async () => {
    try {
      // First check if a task is currently running
      const statusRes = await fetch(
        `http://localhost:3456/api/summary/status?year=${year}`
      );
      if (statusRes.ok) {
        const status = await statusRes.json();
        if (status.isRunning) {
          // Task is running, show generator
          setView("generator");
          setShouldResetCheckpoint(false);
          return;
        }
      }

      // Check if we have completed data
      const data = await getYearlySummary(year);
      if (data && data.content) {
        setView("review");
      } else {
        setView("preview");
        setShouldResetCheckpoint(false);
      }
    } catch (error) {
      console.error("Failed to check existing data", error);
      setView("preview");
      setShouldResetCheckpoint(false);
    }
  };

  const handlePreviewConfirm = () => {
    setView("generator");
  };

  const handlePreviewCancel = () => {
    if (shouldResetCheckpoint) {
      // Regenerate mode - go back to review
      setView("review");
    } else {
      // First time generate - stay on preview or go to review if data exists
      checkData();
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
      {view === "preview" && (
        <GenerationPreview
          mode={shouldResetCheckpoint ? "regenerate" : "generate"}
          year={year}
          since={`${year}-01-01`}
          until={`${year}-12-31`}
          repos={selectedRepos}
          author={author}
          onConfirm={handlePreviewConfirm}
          onCancel={handlePreviewCancel}
        />
      )}

      {view === "generator" && (
        <YearEndGenerator
          onComplete={handleGenerationComplete}
          year={year}
          shouldResetCheckpoint={shouldResetCheckpoint}
        />
      )}

      {view === "review" && <YearEndReview year={year} />}
    </div>
  );
}
