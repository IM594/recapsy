import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
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
import { getSummaryApiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSettings } from "@/hooks/useSettings";
import { useSummary } from "@/hooks/useSummary";

interface YearEndGeneratorProps {
  onComplete: () => void;
  year?: number;
  shouldResetCheckpoint?: boolean;
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
  year = new Date().getFullYear(),
  shouldResetCheckpoint = false,
}: YearEndGeneratorProps) {
  const { selectedRepos, author } = useSettings();
  const { status, logs, startGeneration } = useSummary();
  const since = `${year}-01-01`;
  const until = `${year}-12-31`;

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
      id: "weekly",
      title: "Structuring Weeks",
      description: "Aggregating weekly reports",
      status: "pending",
      weight: 20,
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

  // Track if we've started a new task to prevent quick jump on mount
  const hasStartedNewTask = useRef(false);

  // Sync hook status with UI steps
  useEffect(() => {
    // Mark that we've started when task begins running
    if (status.isRunning) {
      hasStartedNewTask.current = true;
    }

    // Only trigger completion if this is a NEW task we started
    if (
      !status.isRunning &&
      status.phase === "complete" &&
      hasStartedNewTask.current
    ) {
      setSteps((s) => s.map((step) => ({ ...step, status: "completed" })));
      // Delay completion callback slightly
      const timer = setTimeout(() => {
        onComplete();
      }, 1500);
      return () => clearTimeout(timer);
    }

    if (status.currentStep) {
      const stepMapping: Record<string, string> = {
        setup: "collect",
        collect_data: "collect",
        // Subgraph Phase Nodes
        daily_phase: "daily",
        weekly_phase: "weekly",
        monthly_phase: "monthly",
        // Internal Subgraph Nodes (keep for safety/granularity)
        fan_out_daily: "daily",
        process_single_daily: "daily",
        // Map new weekly/monthly nodes to the "monthly" (Aggregation) step
        fan_out_weekly: "weekly",
        process_single_week: "weekly",
        fan_out_monthly: "monthly",
        process_single_month: "monthly",
        yearly_summarizer: "yearly",
        persist: "yearly",
      };

      const activeStepId =
        stepMapping[status.currentStep] || status.currentStep;

      setSteps((prev) => {
        // Mark previous steps as completed
        const activeIndex = prev.findIndex((p) => p.id === activeStepId);
        if (activeIndex === -1) return prev;

        return prev.map((step, index) => {
          if (index < activeIndex) return { ...step, status: "completed" };
          if (step.id === activeStepId) return { ...step, status: "running" };
          return { ...step, status: "pending" };
        });
      });
    }

    if (status.phase === "error") {
      setSteps((prev) => {
        // Find the running step and mark as error
        return prev.map((step) =>
          step.status === "running" ? { ...step, status: "error" } : step
        );
      });
    }
  }, [status, onComplete]);

  const handleStart = async () => {
    if (selectedRepos.length === 0) {
      toast.error("Please configure repositories in settings first");
      return;
    }

    // If we need to reset checkpoint (regenerate mode)
    if (shouldResetCheckpoint) {
      try {
        const res = await fetch(getSummaryApiUrl("/reset"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ year }),
        });
        if (!res.ok) {
          toast.error("Failed to reset status");
          return;
        }
      } catch {
        toast.error("Failed to reset status");
        return;
      }
    }

    // Start generation
    startGeneration({
      selectedRepos,
      since,
      until,
      summaryType: "yearly",
      author,
      year,
    });
  };

  // Auto-start on mount (with protection against duplicate triggers)
  const hasAutoStartedRef = useRef(false);
  useEffect(() => {
    // Prevent double-execution in React StrictMode
    if (hasAutoStartedRef.current) return;
    // Don't auto-start if task is already running
    if (status.isRunning) return;
    hasAutoStartedRef.current = true;
    handleStart();
  }, []);

  if (
    status.isRunning ||
    status.phase === "complete" ||
    status.phase === "error"
  ) {
    return (
      <Card className="max-w-2xl mx-auto border-2 shadow-sm animate-in zoom-in-95 duration-700">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto bg-indigo-100 p-3 rounded-full w-fit mb-4">
            <Loader2
              className={cn(
                "h-8 w-8 text-indigo-600",
                status.isRunning && "animate-spin"
              )}
            />
          </div>
          <CardTitle>Generating {year} Review</CardTitle>
          <CardDescription>
            {status.phase === "error"
              ? "An error occurred during generation."
              : "Hold tight, we're condensing a year of work into insights."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Global progress removed as per user request */}

          <div className="space-y-3">
            {steps.map((step) => (
              <div key={step.id} className="flex items-center gap-3 text-sm">
                <div
                  className={cn(
                    "w-2 h-2 rounded-full",
                    step.status === "completed" && "bg-green-500",
                    step.status === "running" && "bg-indigo-500 animate-pulse",
                    step.status === "error" && "bg-red-500",
                    step.status === "pending" && "bg-slate-200"
                  )}
                />
                <span
                  className={cn(
                    step.status === "running"
                      ? "font-medium text-slate-900"
                      : "text-slate-500"
                  )}
                >
                  {step.title}
                </span>
                {step.status === "running" && (
                  <span className="text-xs font-mono text-indigo-600 font-medium ml-auto">
                    {Math.round(status.progress)}%
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
                        log.type === "success" || log.type === "info"
                          ? "text-slate-300"
                          : "text-red-400"
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
