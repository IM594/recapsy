import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getSummaryApiUrl } from "@/lib/api";

interface YearContextType {
  activeYear: number;
  setActiveYear: (year: number) => void;
  availableYears: number[];
  refreshAvailableYears: () => Promise<void>;
}

const YearContext = createContext<YearContextType | null>(null);

const STORAGE_KEY = "recaply_active_year";

export function YearProvider({ children }: { children: ReactNode }) {
  const currentYear = new Date().getFullYear();

  const [availableYears, setAvailableYears] = useState<number[]>([currentYear]);
  const [activeYear, setActiveYearState] = useState<number>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) ? parsed : currentYear;
  });

  const refreshAvailableYears = useCallback(async () => {
    try {
      const res = await fetch(getSummaryApiUrl("/years"));
      if (!res.ok) throw new Error("Failed to fetch years");
      const data = (await res.json()) as { years?: number[] };

      const yearsSet = new Set<number>([currentYear]);
      for (const y of data.years || []) {
        if (Number.isFinite(y)) yearsSet.add(y);
      }

      const years = Array.from(yearsSet).sort((a, b) => b - a);
      setAvailableYears(years);

      // Ensure active year is always a valid option; fallback to currentYear.
      setActiveYearState((prev) => (years.includes(prev) ? prev : currentYear));
    } catch {
      setAvailableYears([currentYear]);
      setActiveYearState((prev) => (Number.isFinite(prev) ? prev : currentYear));
    }
  }, [currentYear]);

  const setActiveYear = useCallback((year: number) => {
    setActiveYearState(year);
    localStorage.setItem(STORAGE_KEY, String(year));
  }, []);

  useEffect(() => {
    refreshAvailableYears();
  }, [refreshAvailableYears]);

  const value = useMemo<YearContextType>(() => {
    return {
      activeYear,
      setActiveYear,
      availableYears,
      refreshAvailableYears,
    };
  }, [activeYear, availableYears, refreshAvailableYears, setActiveYear]);

  return <YearContext.Provider value={value}>{children}</YearContext.Provider>;
}

export function useYear() {
  const ctx = useContext(YearContext);
  if (!ctx) {
    throw new Error("useYear must be used within a YearProvider");
  }
  return ctx;
}
