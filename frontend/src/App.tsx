import { useState } from "react";
import { ResultCard } from "./components/ResultCard";
import { YearEndContainer } from "./components/YearEndContainer";
import { Dashboard } from "./components/Dashboard";
import { Sparkles, ArrowLeft, X } from "lucide-react";
import { Toaster, toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SettingsProvider, useSettings } from "./hooks/useSettings";
import { Dialog, DialogContent } from "@/components/ui/dialog";

type ViewState = "dashboard" | "review";

function AppContent() {
  const [view, setView] = useState<ViewState>("dashboard");
  const [yearEndMode, setYearEndMode] = useState<"view" | "regenerate">("view");

  const [generationResult, setGenerationResult] = useState<any>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const { selectedRepos } = useSettings();

  // Helper to format date
  const formatLocal = (date: Date) => {
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate()
    )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
      date.getSeconds()
    )}`;
  };

  const getStartOfDay = (date: Date) => {
    const newDate = new Date(date);
    newDate.setHours(0, 0, 0, 0);
    return newDate;
  };

  const handleGenerate = async (type: "today" | "week" | "month") => {
    setIsGenerating(true);
    setGenerationResult(null);

    // Calculate dates based on type
    const now = new Date();
    let since = "";
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    const until = formatLocal(endOfToday);

    if (type === "today") {
      since = formatLocal(getStartOfDay(now));
    } else if (type === "week") {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(now);
      monday.setDate(diff);
      since = formatLocal(getStartOfDay(monday));
    } else if (type === "month") {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      since = formatLocal(getStartOfDay(firstDay));
    }

    try {
      const response = await fetch("http://localhost:3456/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedRepos: selectedRepos, // Use global settings
          since,
          until,
          summaryType: type,
        }),
      });

      if (!response.ok) throw new Error("Generation failed");

      const resData = await response.json();
      if (resData.status === "completed") {
        setGenerationResult({
          summary: resData.summary,
          outputPath: resData.outputPath,
        });
        toast.success("Summary generated!");
      } else {
        toast.error("Generation failed");
      }
    } catch (error: any) {
      console.error(error);
      toast.error(`Error: ${error.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="flex items-center justify-between">
          <div
            className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
            onClick={() => setView("dashboard")}
          >
            <div className="bg-slate-900 text-white p-2 rounded-lg">
              <Sparkles className="h-5 w-5" />
            </div>
            <span className="font-bold text-xl tracking-tight text-slate-900">
              Daily Work Summarizer
            </span>
          </div>

          {view !== "dashboard" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setView("dashboard")}
              className="text-slate-500 hover:text-slate-900"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dashboard
            </Button>
          )}
        </header>

        <main className="min-h-[600px] relative">
          {view === "dashboard" && (
            <Dashboard
              onGenerate={handleGenerate}
              onViewYearReview={(mode) => {
                setYearEndMode(mode);
                setView("review");
              }}
              isGenerating={isGenerating}
            />
          )}

          {view === "review" && (
            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
              <YearEndContainer forcedMode={yearEndMode} />
            </div>
          )}
        </main>
      </div>

      {/* Result Overlay Dialog */}
      <Dialog
        open={!!generationResult}
        onOpenChange={(open) => !open && setGenerationResult(null)}
      >
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <div className="absolute right-4 top-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setGenerationResult(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          {generationResult && (
            <div className="mt-6">
              <ResultCard
                summary={generationResult.summary}
                outputPath={generationResult.outputPath}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Toaster />
    </div>
  );
}

function App() {
  return (
    <SettingsProvider>
      <AppContent />
    </SettingsProvider>
  );
}

export default App;
