import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { fetchAvailableYears } from "@/services/summary";
import { STORAGE_KEYS } from "@recaply/shared";
import { logError } from "@/lib/logger";

interface YearContextType {
  activeYear: number;
  setActiveYear: (year: number) => void;
  availableYears: number[];
  refreshAvailableYears: () => Promise<void>;
}

const YearContext = createContext<YearContextType | null>(null);

export function YearProvider({ children }: { children: ReactNode }) {
  const currentYear = new Date().getFullYear();

  const [availableYears, setAvailableYears] = useState<number[]>([currentYear]);
  const [activeYear, setActiveYearState] = useState<number>(() => {
    const raw = localStorage.getItem(STORAGE_KEYS.year.activeYear);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) ? parsed : currentYear;
  });

  const refreshAvailableYears = useCallback(async () => {
    try {
      const years = await fetchAvailableYears();
      setAvailableYears(years);

      // Ensure active year is always a valid option; fallback to currentYear.
      setActiveYearState((prev) => (years.includes(prev) ? prev : currentYear));
    } catch (error) {
      logError("year.refreshAvailableYears", error, { currentYear });
      setAvailableYears([currentYear]);
      setActiveYearState((prev) => (Number.isFinite(prev) ? prev : currentYear));
    }
  }, [currentYear]);

  const setActiveYear = useCallback((year: number) => {
    setActiveYearState(year);
    localStorage.setItem(STORAGE_KEYS.year.activeYear, String(year));
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
