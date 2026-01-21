import { CalendarRange } from "lucide-react";
import { cn } from "@/lib/utils";
import { useYear } from "@/hooks/YearContext";
import { COPY } from "@/constants/copy";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function YearSwitcher({ className }: { className?: string }) {
  const { activeYear, availableYears, setActiveYear } = useYear();

  return (
    <Select
      value={String(activeYear)}
      onValueChange={(v) => setActiveYear(Number(v))}
    >
      <SelectTrigger
        aria-label={COPY.common.aria.selectYear}
        className={cn("w-[140px] bg-white", className)}
      >
        <CalendarRange className="h-4 w-4 text-slate-500" />
        <SelectValue placeholder={COPY.common.placeholders.year} />
      </SelectTrigger>
      <SelectContent>
        {availableYears.map((y) => (
          <SelectItem key={y} value={String(y)}>
            {y}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
