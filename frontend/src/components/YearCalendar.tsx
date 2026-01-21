import { Calendar as DateCalendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";

interface YearCalendarProps {
  year: number;
  selected: Date | undefined;
  onSelect: (date: Date | undefined) => void;
  className?: string;
}

export function YearCalendar({
  year,
  selected,
  onSelect,
  className,
}: YearCalendarProps) {
  return (
    <div className={cn("rounded-md border bg-white p-2", className)}>
      <DateCalendar
        mode="single"
        selected={selected}
        onSelect={onSelect}
        fromDate={new Date(year, 0, 1)}
        toDate={new Date(year, 11, 31)}
        captionLayout="dropdown"
      />
    </div>
  );
}

