import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { format, eachDayOfInterval, startOfWeek, endOfWeek } from "date-fns";
import { COPY } from "@/constants/copy";

interface ContributionGraphProps {
  data: Date[];
  year: number;
  onSelectDate?: (date: Date) => void;
  className?: string;
}

export function ContributionGraph({
  data,
  year,
  onSelectDate,
  className,
}: ContributionGraphProps) {
  // Generate the grid of days for the last ~53 weeks (or full year)
  const days = useMemo(() => {
    // Start from Jan 1 of the target year
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);

    // Adjust start to begin at the start of the week (Sunday/Monday) for alignment
    const gridStart = startOfWeek(start);
    const gridEnd = endOfWeek(end);

    return eachDayOfInterval({ start: gridStart, end: gridEnd });
  }, [year]);

  // Map data to a set for O(1) lookup
  const activitySet = useMemo(() => {
    return new Set(data.map((d) => format(d, "yyyy-MM-dd")));
  }, [data]);

  // Group by weeks for column layout
  const weeks = useMemo(() => {
    const weeksArray: Date[][] = [];
    let currentWeek: Date[] = [];

    days.forEach((day, i) => {
      currentWeek.push(day);
      if (currentWeek.length === 7 || i === days.length - 1) {
        weeksArray.push(currentWeek);
        currentWeek = [];
      }
    });
    return weeksArray;
  }, [days]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex gap-1 overflow-x-auto pb-2 scrollbar-hide mask-fade-right">
        {weeks.map((week, weekIndex) => (
          <div key={weekIndex} className="flex flex-col gap-1">
            {week.map((day) => {
              const dateStr = format(day, "yyyy-MM-dd");
              const hasActivity = activitySet.has(dateStr);
              // Only render if within the actual requested year (don't show padded days from prev/next year heavily)
              const isTargetYear = day.getFullYear() === year;

              return (
                <button
                  key={dateStr}
                  onClick={() => isTargetYear && onSelectDate?.(day)}
                  title={`${dateStr} ${hasActivity ? COPY.contributionGraph.activityMark : ""}`}
                  className={cn(
                    "w-2.5 h-2.5 rounded-[2px] transition-all",
                    !isTargetYear
                      ? "opacity-0 pointer-events-none"
                      : "hover:ring-1 hover:ring-slate-400 hover:scale-125 z-10",
                    hasActivity
                      ? "bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.4)]"
                      : "bg-slate-100 dark:bg-slate-800"
                  )}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between text-[10px] text-slate-400 px-1">
        <span>{COPY.contributionGraph.monthLabels.jan}</span>
        <span>{COPY.contributionGraph.monthLabels.jun}</span>
        <span>{COPY.contributionGraph.monthLabels.dec}</span>
      </div>
    </div>
  );
}
