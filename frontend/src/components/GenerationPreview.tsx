import { useState, useEffect, useRef } from "react";
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
import { Label } from "@/components/ui/label";
import { YearCalendar } from "@/components/YearCalendar";
import { MonthSelect } from "@/components/MonthSelect";
import { COPY } from "@/constants/copy";
import { SUMMARY_TYPES } from "@recaply/shared";
import {
  fetchDailySummaries,
  fetchMonthlySummaries,
  fetchWeeklySummaries,
  fetchYearlySummary,
} from "@/services/summary";
import type { GenerationConfig, SummaryType } from "@/types/summary";
import { logError } from "@/lib/logger";
import { isAbortError } from "@/lib/lifecycle";

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
  const existenceControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      if (type === SUMMARY_TYPES.daily || type === SUMMARY_TYPES.weekly) {
        const today = new Date();
        setSelectedDate(
          year === today.getFullYear() ? today : new Date(year, 0, 1)
        );
      }
      if (type === SUMMARY_TYPES.monthly) {
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
      type === SUMMARY_TYPES.monthly
        ? new Date(year, Number.parseInt(selectedMonth, 10) - 1, 1)
        : selectedDate || new Date(year, 0, 1);

    const { startStr, endStr } = getDateRangeForType(
      type,
      referenceDate,
      year
    );

    setDateRange({ start: startStr, end: endStr });
    checkExistence(type, startStr);

    return () => {
      existenceControllerRef.current?.abort();
      existenceControllerRef.current = null;
    };
  }, [open, selectedDate, selectedMonth, type, year]);

  const checkExistence = async (type: GenerationType, rangeStart: string) => {
    setChecking(true);
    setExists(false);
    existenceControllerRef.current?.abort();
    const controller = new AbortController();
    existenceControllerRef.current = controller;
    try {
      let found = false;

      // Match by rangeStart to stay consistent with getDateRangeForType().
      if (type === SUMMARY_TYPES.daily) {
        found = (await fetchDailySummaries(year, undefined, { signal: controller.signal })).some(
          (d) => d.date === rangeStart
        );
      } else if (type === SUMMARY_TYPES.weekly) {
        found = (await fetchWeeklySummaries(year, { signal: controller.signal })).some(
          (d) => d.weekStart === rangeStart
        );
      } else if (type === SUMMARY_TYPES.monthly) {
        const targetMonth = rangeStart.substring(0, 7);
        found = (await fetchMonthlySummaries(year, { signal: controller.signal })).some(
          (d) => d.month === targetMonth
        );
      } else if (type === SUMMARY_TYPES.yearly) {
        const data = await fetchYearlySummary(year, { signal: controller.signal });
        found = !!data?.content;
      }

      setExists(found);
    } catch (error) {
      if (isAbortError(error)) return;
      logError("generationPreview.checkExistence", error, { type, year, rangeStart });
    } finally {
      if (existenceControllerRef.current === controller) {
        setChecking(false);
      }
    }
  };

  const handleGenerate = async () => {
    onOpenChange(false);

    const referenceDate =
      type === SUMMARY_TYPES.monthly
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-blue-500" />
            {COPY.generationPreview.title(type, year)}
          </DialogTitle>
          <DialogDescription>
            {COPY.generationPreview.description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {(type === SUMMARY_TYPES.daily || type === SUMMARY_TYPES.weekly) && (
            <div className="space-y-2">
              <Label>{COPY.common.labels.pickDate}</Label>
              <YearCalendar
                year={year}
                selected={selectedDate}
                onSelect={setSelectedDate}
              />
              <p className="text-xs text-muted-foreground">
                {COPY.generationPreview.help.dailyOrWeekly(type)}
              </p>
            </div>
          )}

          {type === SUMMARY_TYPES.monthly && (
            <div className="space-y-2">
              <Label>{COPY.common.labels.pickMonth}</Label>
              <MonthSelect
                year={year}
                value={selectedMonth}
                onValueChange={setSelectedMonth}
              />
              <p className="text-xs text-muted-foreground">
                {COPY.generationPreview.help.monthly(year)}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{COPY.common.labels.timeRange}</span>
              <span className="font-medium font-mono bg-slate-100 px-2 py-0.5 rounded">
                {dateRange.start} → {dateRange.end}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{COPY.common.labels.repositories}</span>
              <span className="font-medium">
                {selectedRepos.length} selected
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{COPY.common.labels.author}</span>
              <span className="font-medium">{author}</span>
            </div>
          </div>

          {checking ? (
            <div className="flex items-center justify-center py-4 text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {COPY.generationPreview.checkingExistingData}
            </div>
          ) : exists ? (
            <Alert
              variant="destructive"
              className="bg-amber-50 border-amber-200 text-amber-800"
            >
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertTitle>{COPY.generationPreview.alreadyExists.title}</AlertTitle>
              <AlertDescription>
                {COPY.generationPreview.alreadyExists.description}
              </AlertDescription>
            </Alert>
          ) : (
            <Alert className="bg-blue-50 border-blue-200 text-blue-800">
              <CheckCircle2 className="h-4 w-4 text-blue-600" />
              <AlertTitle>{COPY.generationPreview.ready.title}</AlertTitle>
              <AlertDescription>
                {COPY.generationPreview.ready.description}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {COPY.common.buttons.cancel}
          </Button>
          <Button
            onClick={handleGenerate}
            className={
              exists
                ? "bg-amber-600 hover:bg-amber-700"
                : "bg-blue-600 hover:bg-blue-700"
            }
          >
            {exists
              ? COPY.generationPreview.buttons.overwriteGenerate
              : COPY.generationPreview.buttons.generateSummary}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
