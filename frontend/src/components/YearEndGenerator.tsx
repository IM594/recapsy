import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Loader2,
  CheckCircle2,
  Sparkles,
  GitGraph,
  User,
  AlertCircle,
  ArrowRight,
  Circle,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronDown, ChevronRight } from "lucide-react";

interface Repo {
  name: string;
  path: string;
}

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
}

export function YearEndGenerator({
  onComplete,
  year = 2025,
}: YearEndGeneratorProps) {
  // Config State
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<string[]>(() => {
    const saved = localStorage.getItem("ye_selected_repos");
    try {
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [author, setAuthor] = useState(
    () => localStorage.getItem("ye_author") || ""
  );
  const [since, setSince] = useState(
    () => localStorage.getItem("ye_since") || `${year}-01-01`
  );
  const [until, setUntil] = useState(
    () => localStorage.getItem("ye_until") || `${year}-12-31`
  );

  // Execution State
  const [isExecuting, setIsExecuting] = useState(false);
  const [logs, setLogs] = useState<StepResult[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [steps, setSteps] = useState<ProcessStep[]>([
    {
      id: "collect",
      title: "Data Collection",
      description: "Collecting git commits and diffs",
      status: "pending",
    },
    {
      id: "daily",
      title: "Daily Processing",
      description: "Generating summaries for each active day",
      status: "pending",
    },
    {
      id: "monthly",
      title: "Monthly Aggregation",
      description: "Compiling monthly reports",
      status: "pending",
    },
    {
      id: "yearly",
      title: "Annual Review",
      description: "Synthesizing the final year-end summary",
      status: "pending",
    },
  ]);

  // Load repos
  useEffect(() => {
    const fetchRepos = async () => {
      try {
        const response = await fetch(
          "http://localhost:3456/api/repos?rootPath=/Users/user/Downloads/projects"
        );
        if (response.ok) {
          const data = await response.json();
          setRepos(data.repos || []);
        }
      } catch (error) {
        console.error("Failed to load repos:", error);
      }
    };
    fetchRepos();
  }, []);

  // Save state changes
  useEffect(() => {
    localStorage.setItem("ye_author", author);
  }, [author]);

  useEffect(() => {
    localStorage.setItem("ye_since", since);
  }, [since]);

  useEffect(() => {
    localStorage.setItem("ye_until", until);
  }, [until]);

  useEffect(() => {
    localStorage.setItem("ye_selected_repos", JSON.stringify(selectedRepos));
  }, [selectedRepos]);

  const toggleRepo = (path: string) => {
    setSelectedRepos((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  const updateStepStatus = (id: string, status: StepStatus) => {
    setSteps((prev) =>
      prev.map((step) => (step.id === id ? { ...step, status } : step))
    );
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
      toast.error("Please select at least one repository");
      return;
    }
    if (!author) {
      toast.error("Please enter an author name");
      return;
    }

    setIsExecuting(true);
    setLogs([]);
    setSteps((s) => s.map((step) => ({ ...step, status: "pending" })));

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

      const totalCommits = dailyData.reduce(
        (sum, d) => sum + (d.commits?.length || 0),
        0
      );
      addLog(
        "Data Collection",
        true,
        `Found ${totalCommits} commits across ${dailyData.length} days.`
      );
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
              if (res.success) {
                dailySummaries.push(res.output);
                addLog(
                  "Daily Summary",
                  true,
                  `Summary generated for ${day.date}`
                );
              } else {
                addLog(
                  "Daily Summary",
                  false,
                  `Failed for ${day.date}: ${res.error}`
                );
              }
            } catch (err) {
              addLog("Daily Summary", false, `Error for ${day.date}`);
            }
          })
        );
      }

      if (dailySummaries.length === 0) {
        throw new Error("Failed to generate any daily summaries");
      }
      updateStepStatus("daily", "completed");

      // Step 3: Monthly Summaries
      updateStepStatus("monthly", "running");
      const months = new Set(dailySummaries.map((d) => d.date.substring(0, 7)));
      const monthlySummaries = [];
      const monthList = Array.from(months).sort();

      for (const month of monthList) {
        const monthDailies = dailySummaries.filter((d) =>
          d.date.startsWith(month as string)
        );
        const res = await executeNode("monthly_summarizer", {
          month,
          dailySummaries: monthDailies,
        });

        if (res.success) {
          monthlySummaries.push(res.output);
          addLog("Monthly Summary", true, `Generated for ${month}`);
        } else {
          addLog("Monthly Summary", false, `Failed for ${month}: ${res.error}`);
        }
      }
      updateStepStatus("monthly", "completed");

      // Step 4: Annual Summary
      updateStepStatus("yearly", "running");
      const yearlyResult = await executeNode("yearly_summarizer", {
        year,
        monthlySummaries,
      });

      if (!yearlyResult.success) {
        throw new Error(yearlyResult.error);
      }
      updateStepStatus("yearly", "completed");

      addLog("Annual Summary", true, "Review generation complete!");
      toast.success("All Done! Redirecting to review...");

      setTimeout(() => {
        onComplete();
      }, 1000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const currentStepIndex = steps.findIndex((s) => s.status === "running");
      if (currentStepIndex !== -1) {
        updateStepStatus(steps[currentStepIndex].id, "error");
      }
      addLog("Error", false, msg);
      toast.error(`Error: ${msg}`);
      setIsExecuting(false);
    }
  };

  if (isExecuting) {
    return (
      <Card className="max-w-3xl mx-auto border-2 border-slate-200 shadow-sm">
        <CardHeader className="border-b bg-slate-50/50">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-indigo-500 animate-pulse" />
            Generating Your Year-End Review
          </CardTitle>
          <CardDescription>
            Please wait while we analyze your work patterns and generate
            insights.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-6 space-y-8">
          {/* Steps */}
          <div className="space-y-4">
            {steps.map((step) => (
              <div
                key={step.id}
                className={`flex items-start gap-4 p-3 rounded-lg transition-colors ${
                  step.status === "running" ? "bg-indigo-50/50" : ""
                }`}
              >
                <div className="mt-1">
                  {step.status === "pending" && (
                    <Circle className="h-5 w-5 text-slate-300" />
                  )}
                  {step.status === "running" && (
                    <Loader2 className="h-5 w-5 text-indigo-500 animate-spin" />
                  )}
                  {step.status === "completed" && (
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                  )}
                  {step.status === "error" && (
                    <AlertCircle className="h-5 w-5 text-red-500" />
                  )}
                </div>
                <div className="flex-1">
                  <h4
                    className={`text-sm font-medium ${
                      step.status === "running"
                        ? "text-indigo-700"
                        : step.status === "completed"
                        ? "text-slate-700"
                        : "text-slate-500"
                    }`}
                  >
                    {step.title}
                  </h4>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {step.description}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <Separator />

          {/* Logs */}
          <div className="border rounded-md bg-slate-900 text-slate-200 font-mono text-xs overflow-hidden">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowLogs(!showLogs)}
              className="w-full flex justify-between items-center px-4 hover:bg-slate-800 hover:text-white rounded-none"
            >
              <span className="flex items-center gap-2">
                <Terminal className="h-4 w-4" />
                Execution Logs
              </span>
              {showLogs ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </Button>
            {showLogs && (
              <ScrollArea className="h-64 p-4 pt-0">
                <div className="space-y-1.5 mt-2">
                  {logs.map((log, i) => (
                    <div key={i} className="flex gap-3">
                      <span className="text-slate-500 shrink-0">
                        {log.timestamp}
                      </span>
                      <span
                        className={
                          log.success ? "text-slate-300" : "text-red-400"
                        }
                      >
                        {log.success ? "✓" : "✗"} [{log.step}] {log.message}
                      </span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-4xl mx-auto border-2 border-slate-200 shadow-sm">
      <CardHeader className="border-b bg-slate-50/50">
        <CardTitle className="flex items-center gap-2 text-xl">
          <Sparkles className="h-6 w-6 text-indigo-500" />
          Start New Review
        </CardTitle>
        <CardDescription>
          Configure how we should gather and analyze your work data for {year}.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x h-full">
          {/* Main Config */}
          <div className="col-span-2 p-6 space-y-8">
            <div className="space-y-4">
              <h3 className="text-sm font-semibold flex items-center gap-2 text-slate-900">
                <User className="h-4 w-4" />
                Identity & Scope
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 space-y-2">
                  <Label>Git Author Name</Label>
                  <Input
                    placeholder="e.g. user"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    We'll filter commits that match this author name.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>From Date</Label>
                  <Input
                    type="date"
                    value={since}
                    onChange={(e) => setSince(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>To Date</Label>
                  <Input
                    type="date"
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <Separator />

            <div className="space-y-4">
              <h3 className="text-sm font-semibold flex items-center gap-2 text-slate-900">
                <GitGraph className="h-4 w-4" />
                Repositories
              </h3>
              <div className="border rounded-md h-64 overflow-hidden flex flex-col">
                <div className="bg-slate-50 p-2 border-b flex justify-between items-center">
                  <span className="text-xs font-medium text-slate-500">
                    Available Repositories
                  </span>
                  <span className="text-xs text-slate-500">
                    {selectedRepos.length} selected
                  </span>
                </div>
                <ScrollArea className="flex-1 p-1">
                  {repos.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-8">
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Loading repos...
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {repos.map((r) => (
                        <label
                          key={r.path}
                          className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded cursor-pointer transition-colors text-sm"
                        >
                          <Checkbox
                            checked={selectedRepos.includes(r.path)}
                            onCheckedChange={() => toggleRepo(r.path)}
                          />
                          <div className="flex flex-col min-w-0">
                            <span className="font-medium truncate text-slate-700">
                              {r.name}
                            </span>
                            <span
                              className="text-xs text-slate-400 truncate"
                              title={r.path}
                            >
                              {r.path}
                            </span>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>
          </div>

          {/* Sidebar Info */}
          <div className="p-6 bg-slate-50/50 space-y-6">
            <div>
              <h4 className="font-medium text-sm text-slate-900 mb-2">
                What happens next?
              </h4>
              <ul className="space-y-3">
                {[
                  {
                    title: "1. Data Collection",
                    desc: "We'll scan selected repos for your commits and active days.",
                  },
                  {
                    title: "2. Daily Analysis",
                    desc: "AI processes each active day to summarize your work.",
                  },
                  {
                    title: "3. Monthly Rollup",
                    desc: "Daily summaries are aggregated into high-level monthly visualizations.",
                  },
                  {
                    title: "4. Annual Review",
                    desc: "A final executive summary of your year's achievements.",
                  },
                ].map((item, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-white border flex items-center justify-center text-xs font-medium text-slate-500 shadow-sm">
                      {i + 1}
                    </span>
                    <div className="space-y-0.5">
                      <span className="font-medium text-slate-700 block">
                        {item.title}
                      </span>
                      <span className="text-slate-500 text-xs leading-relaxed block">
                        {item.desc}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="pt-4 border-t">
              <Button
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white shadow-md hover:shadow-lg transition-all"
                size="lg"
                onClick={handleStart}
              >
                Start Analysis
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
