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
  Play,
  CheckCircle2,
  Sparkles,
  Calendar,
  GitGraph,
  User,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";

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

export function YearEndGenerator({
  onComplete,
  year = 2025,
}: YearEndGeneratorProps) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [author, setAuthor] = useState(
    () => localStorage.getItem("ye_author") || ""
  );
  const [since, setSince] = useState(
    () => localStorage.getItem("ye_since") || `${year}-01-01`
  );
  const [until, setUntil] = useState(
    () => localStorage.getItem("ye_until") || `${year}-12-31`
  );
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState<string>("");
  const [logs, setLogs] = useState<StepResult[]>([]);

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

          // Restore selected repos from local storage
          const saved = localStorage.getItem("ye_selected_repos");
          if (saved) {
            try {
              const parsed = JSON.parse(saved);
              if (Array.isArray(parsed)) setSelectedRepos(parsed);
            } catch (e) {
              console.error("Failed to parse saved repos", e);
            }
          }
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

    setLoading(true);
    setProgress(0);
    setLogs([]);

    try {
      // Step 1: Data Collection
      setCurrentStep("Collecting commits & diffs...");
      toast.info("Starting data collection...");

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
        addLog("Data Collection", false, "No commits found");
        toast.warning("No matching commits found");
        setLoading(false);
        return;
      }

      // Detailed log for collection
      const totalCommits = dailyData.reduce(
        (sum, d) => sum + (d.commits?.length || 0),
        0
      );
      addLog(
        "Data Collection",
        true,
        `Found ${totalCommits} commits across ${dailyData.length} days. Ready to process.`
      );
      setProgress(20);

      // Step 2: Daily Summaries
      setCurrentStep(`Processing ${dailyData.length} daily summaries...`);
      const dailySummaries: any[] = [];

      // Batch process in chunks of 5
      const batchSize = 5;
      for (let i = 0; i < dailyData.length; i += batchSize) {
        const batch = dailyData.slice(i, i + batchSize);
        // Process sequentially or concurrently but update UI per item
        // To update UI properly without batching weirdness, we'll map promises
        // but handle state updates in their .then()

        await Promise.all(
          batch.map(async (day) => {
            try {
              addLog("Processing", true, `Processing ${day.date}...`); // Start log
              const res = await executeNode("daily_summarizer", day);

              if (res.success) {
                dailySummaries.push(res.output);
                addLog(
                  "Daily Summary",
                  true,
                  `✅ ${day.date}: Generated summary (${res.output.summary.length} chars)`
                );
              } else {
                addLog(
                  "Daily Summary",
                  false,
                  `❌ ${day.date}: Failed - ${res.error}`
                );
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              addLog(
                "Daily Summary",
                false,
                `❌ ${day.date}: Error - ${errMsg}`
              );
            }
          })
        );

        const processedCount = Math.min(i + batchSize, dailyData.length);
        const percent =
          20 + Math.floor((processedCount / dailyData.length) * 50);
        setProgress(percent);

        // Log batch completion
        // addLog("Processing", true, `Batch ${Math.floor(i / batchSize) + 1} completed.`);
      }

      if (dailySummaries.length === 0) {
        throw new Error("Failed to generate any daily summaries");
      }

      addLog(
        "Daily Summaries",
        true,
        `Successfully generated ${dailySummaries.length} daily summaries.`
      );

      // Step 3: Monthly Summaries
      setCurrentStep("Aggregating monthly reports...");

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
          addLog(
            "Monthly Summary",
            true,
            `Generated for ${month} (${monthDailies.length} days)`
          );
        } else {
          addLog("Monthly Summary", false, `Failed for ${month}: ${res.error}`);
        }
      }

      addLog(
        "Monthly Summaries",
        true,
        `Completed ${monthlySummaries.length} monthly reports.`
      );
      setProgress(90);

      // Step 4: Annual Summary
      setCurrentStep("Generating Year-End Self Review...");

      const yearlyResult = await executeNode("yearly_summarizer", {
        year,
        monthlySummaries,
      });

      if (!yearlyResult.success) {
        throw new Error(yearlyResult.error);
      }

      addLog("Annual Summary", true, "Year-end review generation complete!");
      setProgress(100);
      toast.success("All Done! Redirecting to review...");

      setTimeout(() => {
        onComplete();
      }, 1000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      addLog(currentStep, false, msg);
      toast.error(`Error: ${msg}`);
      setLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl mx-auto">
      {/* Configuration Form */}
      <Card className="border-2 border-slate-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-indigo-500" />
            Start New Review
          </CardTitle>
          <CardDescription>
            Configure settings for your {year} Self-Review
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Author */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <User className="h-4 w-4" />
              Git Author Name
            </Label>
            <Input
              placeholder="e.g. user (match your git config user.name)"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Used to filter commits strictly authored by you.
            </p>
          </div>

          {/* Date Range */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                From
              </Label>
              <Input
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                To
              </Label>
              <Input
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </div>
          </div>

          {/* Repos */}
          <div className="space-y-3">
            <Label className="flex items-center gap-2">
              <GitGraph className="h-4 w-4" />
              Select Repositories ({selectedRepos.length})
            </Label>
            <div className="border rounded-md h-48 overflow-y-auto p-1 bg-slate-50">
              {repos.length === 0 ? (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Loading repos...
                </div>
              ) : (
                <div className="space-y-1">
                  {repos.map((r) => (
                    <label
                      key={r.path}
                      className="flex items-center gap-2 p-2 hover:bg-white rounded cursor-pointer transition-colors text-sm"
                    >
                      <Checkbox
                        checked={selectedRepos.includes(r.path)}
                        onCheckedChange={() => toggleRepo(r.path)}
                      />
                      <span className="font-medium truncate" title={r.path}>
                        {r.name}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          <Button
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
            size="lg"
            onClick={handleStart}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Analyzing {year} Data...
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                Generate Year-End Summary
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Progress & Logs */}
      <Card className="border-2 border-slate-200 bg-slate-50/50">
        <CardHeader>
          <CardTitle className="text-base">Execution Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {loading ? (
            <div className="space-y-2">
              <div className="flex justify-between text-sm font-medium">
                <span>{currentStep}</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          ) : logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-slate-400 text-sm border-2 border-dashed rounded-lg">
              <Sparkles className="h-8 w-8 mb-2 opacity-50" />
              Ready to start
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center p-4 bg-green-50 border border-green-100 rounded-lg text-green-700 mb-4">
              <CheckCircle2 className="h-8 w-8 mb-2" />
              <span className="font-medium">Analysis Complete</span>
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-xs uppercase text-muted-foreground font-semibold tracking-wider">
              Activity Log
            </Label>
            <div className="bg-white border rounded-md h-[400px] overflow-y-auto p-4 space-y-3 font-mono text-xs shadow-sm">
              {logs.map((log, i) => (
                <div
                  key={i}
                  className="flex gap-3 items-start border-b border-slate-50 last:border-0 pb-2 last:pb-0"
                >
                  <span className="text-slate-400 min-w-[60px]">
                    {log.timestamp}
                  </span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 font-medium text-slate-700">
                      {log.success ? (
                        <CheckCircle2 className="h-3 w-3 text-green-500" />
                      ) : (
                        <AlertCircle className="h-3 w-3 text-red-500" />
                      )}
                      {log.step}
                    </div>
                    {log.message && (
                      <p
                        className={`mt-1 ${
                          log.success ? "text-slate-500" : "text-red-500"
                        }`}
                      >
                        {log.message}
                      </p>
                    )}
                  </div>
                </div>
              ))}
              {logs.length === 0 && !loading && (
                <div className="text-slate-400 italic text-center pt-8">
                  Log output will appear here...
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
