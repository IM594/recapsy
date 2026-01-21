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
import { useSettings } from "@/hooks/useSettings";
import { getDateRangeForType } from "@/lib/date-utils";
import { Calendar as DateCalendar } from "@/components/ui/calendar";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format } from "date-fns";
import { getSummaryApiUrl } from "@/lib/api";
import type { GenerationConfig, SummaryType } from "../hooks/useSummary";

type GenerationType = SummaryType;

type GenerationRequest = Pick<
  GenerationConfig,
  "summaryType" | "year" | "since" | "until"
>;

interface GenerationPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: GenerationType;
  year?: number;
  onGenerateStart: (req: GenerationRequest) => void; // Callback when generation actually starts
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
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [selectedMonth, setSelectedMonth] = useState<string>(() =>
    String(new Date().getMonth() + 1).padStart(2, "0")
  );

  useEffect(() => {
    if (open) {
      if (type === "daily" || type === "weekly") {
        const today = new Date();
        setSelectedDate(
          year === today.getFullYear() ? today : new Date(year, 0, 1)
        );
      }
      if (type === "monthly") {
        const today = new Date();
        setSelectedMonth(
          year === today.getFullYear()
            ? String(today.getMonth() + 1).padStart(2, "0")
            : "01"
        );
      }
    }
  }, [open, type, year]);

  useEffect(() => {
    if (!open) return;

    const referenceDate =
      type === "monthly"
        ? new Date(year, Number.parseInt(selectedMonth, 10) - 1, 1)
        : selectedDate || new Date(year, 0, 1);

    const { startStr, endStr } = getDateRangeForType(
      type,
      referenceDate,
      year
    );

    setDateRange({ start: startStr, end: endStr });
    checkExistence(type, startStr);
  }, [open, selectedDate, selectedMonth, type, year]);

  const checkExistence = async (type: GenerationType, rangeStart: string) => {
    setChecking(true);
    setExists(false);
    try {
      const res = await fetch(
        getSummaryApiUrl(`/data?type=${type}&year=${year}`)
      );
      if (res.ok) {
        const data = await res.json();
        let found = false;

        // 统一使用 rangeStart 来匹配，保证与 dateRange 计算一致
        if (type === "daily") {
          // rangeStart 就是目标日期 YYYY-MM-DD
          found = data.some((d: { date: string }) => d.date === rangeStart);
        } else if (type === "weekly") {
          // rangeStart 是周一日期
          found = data.some((d: { weekStart: string }) => d.weekStart === rangeStart);
        } else if (type === "monthly") {
          // 从 rangeStart (月初日期) 提取月份 YYYY-MM
          const targetMonth = rangeStart.substring(0, 7);
          found = data.some((d: { month: string }) => d.month === targetMonth);
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

    const referenceDate =
      type === "monthly"
        ? new Date(year, Number.parseInt(selectedMonth, 10) - 1, 1)
        : selectedDate || new Date(year, 0, 1);

    const { start, end } = getDateRangeForType(type, referenceDate, year);

    onGenerateStart({
      summaryType: type,
      year,
      since: start.toISOString(),
      until: end.toISOString(),
    });
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
          {(type === "daily" || type === "weekly") && (
            <div className="space-y-2">
              <Label>Pick a date</Label>
              <div className="rounded-md border bg-white p-2">
                <DateCalendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={setSelectedDate}
                  fromDate={new Date(year, 0, 1)}
                  toDate={new Date(year, 11, 31)}
                  captionLayout="dropdown"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                We will generate a {type} summary for the selected period.
              </p>
            </div>
          )}

          {type === "monthly" && (
            <div className="space-y-2">
              <Label>Pick a month</Label>
              <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                <SelectTrigger aria-label="Select month" className="bg-white">
                  <SelectValue placeholder="Select month" />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 12 }).map((_, i) => {
                    const monthIndex = i;
                    const value = String(monthIndex + 1).padStart(2, "0");
                    const label = format(new Date(year, monthIndex, 1), "MMMM");
                    return (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                We will generate a monthly summary for {year}.
              </p>
            </div>
          )}

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
                Existing summaries were found for this period. Generation will{" "}
                <strong>reuse cached results</strong> where available.
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
