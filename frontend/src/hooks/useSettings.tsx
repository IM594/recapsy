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

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [selectedRepos, setSelectedRepos] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("ye_selected_repos");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [author, setAuthor] = useState(() => {
    return localStorage.getItem("ye_author") || "";
  });

  const updateSettings = (repos: string[], newAuthor: string) => {
    setSelectedRepos(repos);
    setAuthor(newAuthor);

    localStorage.setItem("ye_selected_repos", JSON.stringify(repos));
    localStorage.setItem("ye_author", newAuthor);
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
