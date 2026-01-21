import { format } from "date-fns";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface MonthSelectProps {
  year: number;
  value: string;
  onValueChange: (value: string) => void;
  triggerClassName?: string;
  ariaLabel?: string;
  placeholder?: string;
}

export function MonthSelect({
  year,
  value,
  onValueChange,
  triggerClassName,
  ariaLabel = "Select month",
  placeholder = "Select month",
}: MonthSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        aria-label={ariaLabel}
        className={cn("bg-white", triggerClassName)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {Array.from({ length: 12 }).map((_, i) => {
          const monthIndex = i;
          const monthValue = String(monthIndex + 1).padStart(2, "0");
          const monthLabel = format(new Date(year, monthIndex, 1), "MMMM");
          return (
            <SelectItem key={monthValue} value={monthValue}>
              {monthLabel}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

