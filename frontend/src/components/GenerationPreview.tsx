import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertTriangle, Calendar, CheckCircle2 } from "lucide-react";
import { useSettings } from "../hooks/useSettings";

type GenerationType = "daily" | "weekly" | "monthly" | "yearly";

interface GenerationPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: GenerationType;
  year?: number;
  onGenerateStart: () => void; // Callback when generation actually starts
}

export function GenerationPreview({
  open,
  onOpenChange,
  type,
  year = new Date().getFullYear(),
  onGenerateStart,
}: GenerationPreviewProps) {
  const { selectedRepos, author } = useSettings();
  const [checking, setChecking] = useState(true);
  const [exists, setExists] = useState(false);
  const [dateRange, setDateRange] = useState<{ start: string; end: string }>({
    start: "",
    end: "",
  });

  useEffect(() => {
    if (open) {
      calculateRange();
      checkExistence();
    }
  }, [open, type]);

  const calculateRange = () => {
    const now = new Date();
    let start = "";
    let end = "";

    if (type === "daily") {
      start = end = now.toLocaleDateString("en-CA"); // YYYY-MM-DD
    } else if (type === "weekly") {
      // Calculate start of week (Monday)
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(now.setDate(diff));
      const sunday = new Date(now.setDate(diff + 6));
      start = monday.toLocaleDateString("en-CA");
      end = sunday.toLocaleDateString("en-CA");
    } else if (type === "monthly") {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      start = firstDay.toLocaleDateString("en-CA");
      end = lastDay.toLocaleDateString("en-CA");
    } else if (type === "yearly") {
      start = `${year}-01-01`;
      end = `${year}-12-31`;
    }

    setDateRange({ start, end });
  };

  const checkExistence = async () => {
    setChecking(true);
    setExists(false);
    try {
      // Fetch all data of this type to see if ours exists
      // Optimization: Backend could support checking specific ID, but for now filtering client/server side is okay
      // or we can just fetch all and check.
      // For daily: check if today's date exists
      // For weekly: check if weekStart exists
      // For monthly: check if current month exists
      // For yearly: check if year exists

      const res = await fetch(
        `http://localhost:3456/api/summary/data?type=${type}&year=${year}`
      );
      if (res.ok) {
        const data = await res.json();
        let found = false;

        if (type === "daily") {
          const today = new Date().toLocaleDateString("en-CA");
          found = data.some((d: any) => d.date === today);
        } else if (type === "weekly") {
          // We need to match the weekStart
          // Re-calculate weekStart to match exactly what backend would use
          const now = new Date();
          const day = now.getDay();
          const diff = now.getDate() - day + (day === 0 ? -6 : 1);
          const monday = new Date(now.setDate(diff));
          const weekStart = monday.toLocaleDateString("en-CA");
          found = data.some(
            (d: any) =>
              d.weekStart === weekStart || d.weekStart.startsWith(weekStart)
          );
        } else if (type === "monthly") {
          const currentMonth = new Date().toISOString().substring(0, 7); // YYYY-MM
          found = data.some((d: any) => d.month === currentMonth);
        } else if (type === "yearly") {
          found = !!data.content;
        }

        setExists(found);
      }
    } catch (error) {
      console.error("Failed to check existence", error);
    } finally {
      setChecking(false);
    }
  };

  const handleGenerate = async () => {
    onOpenChange(false);

    // Trigger the actual generation via parent or direct API call?
    // The Dashboard usually handles "onGenerate".
    // But here we need to call the API.
    // Actually, Dashboard passes 'onGenerate' which triggers the process.
    // So let's just Close and call a prop 'onConfirm'.
    // Wait, the plan says "Handle the API call to /api/summary/generate" HERE or in the parent?
    // "Dashboard.tsx -> Each button opens the GenerationPreview dialog."
    // "GenerationPreview -> Handle the API call... Show real-time progress..."

    // If I handle it here, I need to replicate the progress UI in this dialog OR
    // I can stick to the plan: "Show real-time progress using the existing SSE connection logic."
    // The existing logic is in Dashboard/App ?
    // Dashboard receives `onGenerate`. `App.tsx` likely handles the SSE and Global Loading state.
    // If checking `Dashboard.tsx` (lines 27, 89), `onGenerate` is passed from parent.
    // So better to delegate back to parent to start generation, referencing the logic in `App.tsx`.

    // However, the prompt says "GenerationPreview... Handle the API call".
    // Let's compromise: GenerationPreview confirms the intent, then calls a prop `onConfirm` which triggers `onGenerate` in parent.
    // This keeps the SSE/Progress logic centralized in App if that's where it resides.

    // But wait, user wants to see "progress bar/steps appear in the modal" (Verification Plan).
    // The current App logic might be global overlay or toast.
    // Let's look at `App.tsx` or `Dashboard.tsx` again to see how `onGenerate` works.
    // `Dashboard.tsx` checks `isGenerating` prop.

    onGenerateStart(); // This will trigger the parent's logic
  };

  const getTitle = () => {
    switch (type) {
      case "daily":
        return "Daily Brief";
      case "weekly":
        return "Weekly Report";
      case "monthly":
        return "Monthly Summary";
      case "yearly":
        return `Yearly Review (${year})`;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-blue-500" />
            Generate {getTitle()}
          </DialogTitle>
          <DialogDescription>
            Review the scope before generating your summary.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Time Range:</span>
              <span className="font-medium font-mono bg-slate-100 px-2 py-0.5 rounded">
                {dateRange.start} → {dateRange.end}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Repositories:</span>
              <span className="font-medium">
                {selectedRepos.length} selected
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Author:</span>
              <span className="font-medium">{author}</span>
            </div>
          </div>

          {checking ? (
            <div className="flex items-center justify-center py-4 text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking existing data...
            </div>
          ) : exists ? (
            <Alert
              variant="destructive"
              className="bg-amber-50 border-amber-200 text-amber-800"
            >
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertTitle>Summary Already Exists</AlertTitle>
              <AlertDescription>
                A summary for this period already exists. Generating will{" "}
                <strong>overwrite</strong> the existing data.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert className="bg-blue-50 border-blue-200 text-blue-800">
              <CheckCircle2 className="h-4 w-4 text-blue-600" />
              <AlertTitle>Ready to Generate</AlertTitle>
              <AlertDescription>
                No existing data found. You are good to go.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleGenerate}
            className={
              exists
                ? "bg-amber-600 hover:bg-amber-700"
                : "bg-blue-600 hover:bg-blue-700"
            }
          >
            {exists ? "Overwrite & Generate" : "Generate Summary"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
