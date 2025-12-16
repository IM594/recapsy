import { useState, useEffect } from "react";
import {
  Sparkles,
  CalendarDays,
  Calendar,
  Trophy,
  ArrowRight,
  Clock,
  Settings,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useSettings } from "../hooks/useSettings";
import { SettingsDialog } from "./SettingsDialog";
import { toast } from "sonner";

interface DashboardProps {
  onGenerate: (type: "today" | "week" | "month") => Promise<void>;
  onViewYearReview: (mode: "view" | "regenerate") => void;
  year?: number;
  isGenerating?: boolean;
}

export function Dashboard({
  onGenerate,
  onViewYearReview,
  year = 2025,
  isGenerating = false,
}: DashboardProps) {
  const { isConfigured } = useSettings();
  const [showSettings, setShowSettings] = useState(false);

  const [hasYearlyData, setHasYearlyData] = useState(false);
  const [loadingYearCheck, setLoadingYearCheck] = useState(true);

  // Check for year end data
  useEffect(() => {
    const checkYearlyData = async () => {
      try {
        const res = await fetch(
          `http://localhost:3456/api/summary/data?type=yearly&year=${year}`
        );
        if (res.ok) {
          const data = await res.json();
          // If content is present, we assume it exists
          if (data.content) {
            setHasYearlyData(true);
          }
        }
      } catch (error) {
        console.error("Failed to check yearly data", error);
      } finally {
        setLoadingYearCheck(false);
      }
    };
    checkYearlyData();
  }, [year]);

  const handleAction = async (type: "today" | "week" | "month") => {
    if (!isConfigured) {
      toast.info("Please configure your repositories first");
      setShowSettings(true);
      return;
    }
    await onGenerate(type);
  };

  const handleYearEndAction = (mode: "view" | "regenerate") => {
    if (!isConfigured) {
      toast.info("Please configure your repositories first");
      setShowSettings(true);
      return;
    }
    onViewYearReview(mode);
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-700 relative">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-slate-900">
            Work Dashboard
          </h2>
          <p className="text-muted-foreground mt-1">
            {isConfigured
              ? "Ready to generate summaries from your connected repos."
              : "Connect your repositories to get started."}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-sm text-slate-500 bg-white border px-3 py-1 rounded-full flex items-center gap-2 shadow-sm">
            <Clock className="h-3 w-3" />
            {new Date().toLocaleDateString()}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            <Settings className="h-5 w-5 text-slate-500 hover:text-slate-900 transition-colors" />
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-7">
        {/* Quick Actions - "Make it Happen" Cards */}
        <Card className="col-span-4 border shadow-sm bg-gradient-to-br from-white to-blue-50/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Sparkles className="h-5 w-5 text-blue-500" />
              Quick Generate
            </CardTitle>
            <CardDescription>
              One-click summaries based on configured repos.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Button
                variant="outline"
                className="h-32 flex flex-col items-center justify-center gap-3 hover:border-blue-300 hover:bg-blue-50/50 transition-all border-2 group relative overflow-hidden"
                onClick={() => handleAction("today")}
                disabled={isGenerating}
              >
                {isGenerating ? (
                  <div className="absolute inset-0 bg-white/50 flex items-center justify-center z-10 backdrop-blur-[1px]">
                    <Loader2 className="h-8 w-8 text-blue-500 animate-spin" />
                  </div>
                ) : null}

                <div className="p-3 bg-blue-100/50 text-blue-600 rounded-full group-hover:scale-110 transition-transform duration-300">
                  <CalendarDays className="h-6 w-6" />
                </div>
                <div className="text-center">
                  <span className="font-semibold text-lg block text-slate-700">
                    Daily Brief
                  </span>
                  <span className="text-xs text-slate-500 group-hover:text-blue-600 transition-colors">
                    Summarize today's work
                  </span>
                </div>
              </Button>

              <Button
                variant="outline"
                className="h-32 flex flex-col items-center justify-center gap-3 hover:border-purple-300 hover:bg-purple-50/50 transition-all border-2 group relative overflow-hidden"
                onClick={() => handleAction("week")}
                disabled={isGenerating}
              >
                {isGenerating ? (
                  <div className="absolute inset-0 bg-white/50 flex items-center justify-center z-10 backdrop-blur-[1px]">
                    <Loader2 className="h-8 w-8 text-purple-500 animate-spin" />
                  </div>
                ) : null}

                <div className="p-3 bg-purple-100/50 text-purple-600 rounded-full group-hover:scale-110 transition-transform duration-300">
                  <Calendar className="h-6 w-6" />
                </div>
                <div className="text-center">
                  <span className="font-semibold text-lg block text-slate-700">
                    Weekly Report
                  </span>
                  <span className="text-xs text-slate-500 group-hover:text-purple-600 transition-colors">
                    Review this week's progress
                  </span>
                </div>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Year End Review Status */}
        <Card className="col-span-3 border border-slate-200 flex flex-col shadow-sm bg-gradient-to-br from-white to-amber-50/30">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Trophy className="h-5 w-5 text-amber-500" />
                {year} Review
              </CardTitle>
              {hasYearlyData && (
                <Badge
                  variant="secondary"
                  className="bg-green-100 text-green-700 hover:bg-green-100 border-green-200"
                >
                  Ready
                </Badge>
              )}
            </div>
            <CardDescription>
              A deep dive into your year's contributions.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col justify-end">
            {loadingYearCheck ? (
              <div className="h-12 bg-slate-100 animate-pulse rounded-lg" />
            ) : hasYearlyData ? (
              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="outline"
                  className="h-12 border-amber-200 hover:bg-amber-50 text-amber-700"
                  onClick={() => handleYearEndAction("regenerate")}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Regenerate
                </Button>
                <Button
                  className="h-12 bg-amber-500 hover:bg-amber-600 text-white shadow-amber-200/50 shadow-lg"
                  onClick={() => handleYearEndAction("view")}
                >
                  View Report
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Button>
              </div>
            ) : (
              <Button
                className="w-full h-12 text-lg border-2 border-dashed border-slate-300 bg-transparent text-slate-500 hover:border-amber-500 hover:text-amber-600 hover:bg-amber-50/50 transition-all"
                onClick={() => handleYearEndAction("regenerate")}
              >
                Start {year} Review
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Removed "Recent Activity" as per user request */}

      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />
    </div>
  );
}
