import { useState, createContext, useContext, ReactNode } from "react";
import { LEGACY_STORAGE_KEYS, STORAGE_KEYS } from "@recaply/shared";
import { logWarn } from "@/lib/logger";

interface SettingsContextType {
  selectedRepos: string[];
  author: string;
  updateSettings: (repos: string[], author: string) => void;
  isConfigured: boolean;
}

const SettingsContext = createContext<SettingsContextType | undefined>(
  undefined
);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [selectedRepos, setSelectedRepos] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.settings.selectedRepos);
      if (saved) return JSON.parse(saved);

      const legacy = localStorage.getItem(LEGACY_STORAGE_KEYS.settings.selectedRepos);
      if (legacy) {
        localStorage.setItem(STORAGE_KEYS.settings.selectedRepos, legacy);
        return JSON.parse(legacy);
      }

      return [];
    } catch (error) {
      logWarn("settings.localStorage", "failed to read/parse selectedRepos; using empty", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  });

  const [author, setAuthor] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.settings.author);
    if (saved) return saved;

    const legacy = localStorage.getItem(LEGACY_STORAGE_KEYS.settings.author);
    if (legacy) {
      localStorage.setItem(STORAGE_KEYS.settings.author, legacy);
      return legacy;
    }

    return "";
  });

  const updateSettings = (repos: string[], newAuthor: string) => {
    setSelectedRepos(repos);
    setAuthor(newAuthor);

    localStorage.setItem(STORAGE_KEYS.settings.selectedRepos, JSON.stringify(repos));
    localStorage.setItem(STORAGE_KEYS.settings.author, newAuthor);
  };

  const isConfigured = selectedRepos.length > 0;

  return (
    <SettingsContext.Provider
      value={{ selectedRepos, author, updateSettings, isConfigured }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return context;
}
