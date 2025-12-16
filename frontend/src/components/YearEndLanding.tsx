import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Sparkles, ArrowRight, BookOpen, RefreshCw } from "lucide-react";

interface YearEndLandingProps {
  year: number;
  hasData: boolean;
  onStartNew: () => void;
  onViewReport: () => void;
}

export function YearEndLanding({
  year,
  hasData,
  onStartNew,
  onViewReport,
}: YearEndLandingProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[600px] max-w-4xl mx-auto space-y-12 animate-in fade-in duration-500">
      {/* Hero Section */}
      <div className="text-center space-y-4">
        <div className="inline-flex items-center justify-center p-3 bg-indigo-100 rounded-full mb-4">
          <Sparkles className="h-8 w-8 text-indigo-600" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
          Year-End Review {year}
        </h1>
        <p className="text-lg text-slate-600 max-w-2xl mx-auto">
          Reflect on your achievements, analyze your coding patterns, and
          celebrate your growth over the past year.
        </p>
      </div>

      {/* Action Content */}
      <div className="grid gap-8 w-full max-w-2xl">
        {hasData ? (
          <div className="grid gap-6">
            <Card
              className="border-2 border-indigo-100 bg-indigo-50/30 hover:border-indigo-200 transition-colors cursor-pointer group"
              onClick={onViewReport}
            >
              <CardHeader className="flex flex-row items-center gap-4 space-y-0">
                <div className="p-3 bg-indigo-600 rounded-lg group-hover:bg-indigo-700 transition-colors">
                  <BookOpen className="h-6 w-6 text-white" />
                </div>
                <div className="flex-1">
                  <CardTitle className="text-xl">View Your Report</CardTitle>
                  <CardDescription>
                    Your {year} summary is ready. Dive into your insights.
                  </CardDescription>
                </div>
                <ArrowRight className="h-5 w-5 text-indigo-400 group-hover:translate-x-1 transition-transform" />
              </CardHeader>
            </Card>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">
                  Or
                </span>
              </div>
            </div>

            <Button
              variant="outline"
              size="lg"
              className="w-full gap-2 text-slate-600"
              onClick={onStartNew}
            >
              <RefreshCw className="h-4 w-4" />
              Start a Fresh Review
            </Button>
          </div>
        ) : (
          <Card className="border-2 border-dashed border-slate-200 bg-slate-50/50">
            <CardContent className="flex flex-col items-center justify-center p-10 space-y-6 text-center">
              <div className="space-y-2">
                <h3 className="text-xl font-semibold text-slate-900">
                  Ready to get started?
                </h3>
                <p className="text-slate-500 max-w-md">
                  We'll analyze your Git history and daily summaries to generate
                  a comprehensive year-in-review report.
                </p>
              </div>
              <Button
                size="lg"
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 h-12 text-base shadow-md hover:shadow-lg transition-all"
                onClick={onStartNew}
              >
                <Sparkles className="h-4 w-4 mr-2" />
                Generate {year} Review
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
