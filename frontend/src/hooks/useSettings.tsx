import { useState, createContext, useContext, ReactNode } from "react";

interface SettingsContextType {
  selectedRepos: string[];
  author: string;
  updateSettings: (repos: string[], author: string) => void;
  isConfigured: boolean;
}

const SettingsContext = createContext<SettingsContextType | undefined>(
  undefined
);

const STORAGE_KEYS = {
  repos: "recaply_selected_repos",
  author: "recaply_author",
} as const;

const LEGACY_STORAGE_KEYS = {
  repos: "ye_selected_repos",
  author: "ye_author",
} as const;

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [selectedRepos, setSelectedRepos] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.repos);
      if (saved) return JSON.parse(saved);

      const legacy = localStorage.getItem(LEGACY_STORAGE_KEYS.repos);
      if (legacy) {
        localStorage.setItem(STORAGE_KEYS.repos, legacy);
        return JSON.parse(legacy);
      }

      return [];
    } catch {
      return [];
    }
  });

  const [author, setAuthor] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.author);
    if (saved) return saved;

    const legacy = localStorage.getItem(LEGACY_STORAGE_KEYS.author);
    if (legacy) {
      localStorage.setItem(STORAGE_KEYS.author, legacy);
      return legacy;
    }

    return "";
  });

  const updateSettings = (repos: string[], newAuthor: string) => {
    setSelectedRepos(repos);
    setAuthor(newAuthor);

    localStorage.setItem(STORAGE_KEYS.repos, JSON.stringify(repos));
    localStorage.setItem(STORAGE_KEYS.author, newAuthor);
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
