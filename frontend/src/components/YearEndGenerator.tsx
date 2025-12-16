import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Loader2,
  CheckCircle2,
  Sparkles,
  Play,
  Terminal,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSettings } from "../hooks/useSettings";

interface StepResult {
  step: string;
  success: boolean;
  message?: string;
  timestamp: string;
}

interface YearEndGeneratorProps {
  onComplete: () => void;
  year?: number;
}

type StepStatus = "pending" | "running" | "completed" | "error";

interface ProcessStep {
  id: string;
  title: string;
  description: string;
  status: StepStatus;
  weight: number;
}

export function YearEndGenerator({
  onComplete,
  year = 2025,
}: YearEndGeneratorProps) {
  // Use global settings
  const { selectedRepos, author } = useSettings();

  // Local config override (optional, but let's stick to global for now or allow local override)
  // For V2, we assume global settings are the source of truth to reduce friction.
  const [since] = useState(`${year}-01-01`);
  const [until] = useState(`${year}-12-31`);

  // Execution State
  const [isExecuting, setIsExecuting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<StepResult[]>([]);
  const [steps, setSteps] = useState<ProcessStep[]>([
    {
      id: "collect",
      title: "Collecting Data",
      description: "Scanning git history",
      status: "pending",
      weight: 20,
    },
    {
      id: "daily",
      title: "Analyzing Days",
      description: "Generating daily summaries",
      status: "pending",
      weight: 40,
    },
    {
      id: "monthly",
      title: "Structuring Months",
      description: "Aggregating monthly reports",
      status: "pending",
      weight: 20,
    },
    {
      id: "yearly",
      title: "Finalizing Review",
      description: "Writing executive summary",
      status: "pending",
      weight: 20,
    },
  ]);

  const updateStepStatus = (id: string, status: StepStatus) => {
    setSteps((prev) =>
      prev.map((step) => (step.id === id ? { ...step, status } : step))
    );

    // Calculate progress
    if (status === "completed") {
      setSteps((currentSteps) => {
        const completedWeight = currentSteps
          .filter((s) => s.status === "completed" || s.id === id)
          .reduce((acc, s) => acc + s.weight, 0);
        setProgress(Math.min(completedWeight, 100));
        return currentSteps;
      });
    }
  };

  const addLog = (step: string, success: boolean, message?: string) => {
    setLogs((prev) => [
      { step, success, message, timestamp: new Date().toLocaleTimeString() },
      ...prev,
    ]);
  };

  const executeNode = async (nodeName: string, input: any) => {
    const response = await fetch("http://localhost:3456/api/workflow/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeName, input }),
    });
    return response.json();
  };

  const handleStart = async () => {
    if (selectedRepos.length === 0) {
      toast.error("Please configure repositories in settings first");
      return;
    }

    setIsExecuting(true);
    setLogs([]);
    setSteps((s) => s.map((step) => ({ ...step, status: "pending" })));
    setProgress(0);

    try {
      // Step 1: Data Collection
      updateStepStatus("collect", "running");
      addLog("Data Collection", true, "Starting commit collection...");

      const collectResult = await executeNode("collect_data", {
        repos: selectedRepos,
        since,
        until,
        authorPattern: author,
      });

      if (!collectResult.success) {
        throw new Error(collectResult.error || "Collection failed");
      }

      const dailyData = collectResult.output as any[];
      if (!dailyData || dailyData.length === 0) {
        updateStepStatus("collect", "error");
        addLog("Data Collection", false, "No commits found");
        toast.warning("No matching commits found");
        setIsExecuting(false);
        return;
      }

      updateStepStatus("collect", "completed");

      // Step 2: Daily Summaries
      updateStepStatus("daily", "running");
      const dailySummaries: any[] = [];
      const batchSize = 5;

      for (let i = 0; i < dailyData.length; i += batchSize) {
        const batch = dailyData.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (day) => {
            try {
              const res = await executeNode("daily_summarizer", day);
              if (res.success) dailySummaries.push(res.output);
            } catch (err) {
              // ignore individual errors
            }
          })
        );
        // Micro progress update
        const progressChunk = (batchSize / dailyData.length) * 40; // 40 is weight
        setProgress((p) => Math.min(p + progressChunk, 60));
      }

      if (dailySummaries.length === 0) {
        throw new Error("Failed to generate any daily summaries");
      }
      updateStepStatus("daily", "completed");

      // Step 3: Monthly Summaries
      updateStepStatus("monthly", "running");
      const months = new Set(dailySummaries.map((d) => d.date.substring(0, 7)));
      const monthlySummaries = [];

      for (const month of Array.from(months)) {
        const monthDailies = dailySummaries.filter((d) =>
          d.date.startsWith(month as string)
        );
        const res = await executeNode("monthly_summarizer", {
          month,
          dailySummaries: monthDailies,
        });
        if (res.success) monthlySummaries.push(res.output);
      }
      updateStepStatus("monthly", "completed");

      // Step 4: Annual Summary
      updateStepStatus("yearly", "running");
      const yearlyResult = await executeNode("yearly_summarizer", {
        year,
        monthlySummaries,
      });

      if (!yearlyResult.success) throw new Error(yearlyResult.error);
      updateStepStatus("yearly", "completed");

      toast.success("Review generated successfully!");
      setTimeout(() => onComplete(), 1000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const currentStepIndex = steps.findIndex((s) => s.status === "running");
      if (currentStepIndex !== -1) {
        updateStepStatus(steps[currentStepIndex].id, "error");
      }
      addLog("Error", false, msg);
      toast.error(msg);
      setIsExecuting(false);
    }
  };

  if (isExecuting) {
    return (
      <Card className="max-w-2xl mx-auto border-2 shadow-sm animate-in zoom-in-95 duration-700">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto bg-indigo-100 p-3 rounded-full w-fit mb-4">
            <Loader2 className="h-8 w-8 text-indigo-600 animate-spin" />
          </div>
          <CardTitle>Generating {year} Review</CardTitle>
          <CardDescription>
            Hold tight, we're condensing a year of work into insights.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <div className="flex justify-between text-xs font-medium text-slate-500 uppercase tracking-wider">
              <span>Progress</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>

          <div className="space-y-3">
            {steps.map((step) => (
              <div key={step.id} className="flex items-center gap-3 text-sm">
                <div
                  className={`w-2 h-2 rounded-full ${
                    step.status === "completed"
                      ? "bg-green-500"
                      : step.status === "running"
                      ? "bg-indigo-500 animate-pulse"
                      : step.status === "error"
                      ? "bg-red-500"
                      : "bg-slate-200"
                  }`}
                />
                <span
                  className={`${
                    step.status === "running"
                      ? "font-medium text-slate-900"
                      : "text-slate-500"
                  }`}
                >
                  {step.title}
                </span>
                {step.status === "running" && (
                  <span className="text-xs text-muted-foreground ml-auto">
                    Processing...
                  </span>
                )}
                {step.status === "completed" && (
                  <CheckCircle2 className="h-4 w-4 text-green-500 ml-auto" />
                )}
                {step.status === "error" && (
                  <AlertCircle className="h-4 w-4 text-red-500 ml-auto" />
                )}
              </div>
            ))}
          </div>

          <div className="bg-slate-950 rounded-lg p-3 font-mono text-xs text-slate-400 h-32 overflow-hidden relative">
            <div className="absolute top-2 right-2 opacity-50">
              <Terminal className="h-4 w-4" />
            </div>
            <ScrollArea className="h-full">
              <div className="space-y-1">
                {logs.map((log, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-slate-600 shrink-0">
                      [{log.timestamp}]
                    </span>
                    <span
                      className={
                        log.success ? "text-slate-300" : "text-red-400"
                      }
                    >
                      {log.message}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-2xl mx-auto border-dashed border-2 bg-slate-50/50 shadow-none">
      <CardContent className="flex flex-col items-center justify-center p-12 text-center space-y-6">
        <div className="bg-white p-4 rounded-full shadow-sm ring-1 ring-slate-100">
          <Sparkles className="h-8 w-8 text-indigo-500" />
        </div>
        <div className="space-y-2 max-w-md">
          <h3 className="text-xl font-bold text-slate-900">
            Ready for {year} Review?
          </h3>
          <p className="text-slate-500">
            We will analyze your git history from{" "}
            <span className="font-medium text-slate-900">
              {selectedRepos.length} repositories
            </span>{" "}
            acting as{" "}
            <span className="font-medium text-slate-900">
              {author || "you"}
            </span>
            .
          </p>
        </div>

        <Button
          size="lg"
          onClick={handleStart}
          className="w-full max-w-sm h-12 text-base"
        >
          <Play className="h-4 w-4 mr-2" />
          Start Generation
        </Button>
      </CardContent>
    </Card>
  );
}
