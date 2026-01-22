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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FolderSearch, Loader2, Save } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { toast } from "sonner";
import { scanRepos as scanReposService } from "@/services/repos";
import { COPY } from "@/constants/copy";
import { STORAGE_KEYS } from "@recaply/shared";
import type { RepoInfo } from "@/types/repos";
import { logError } from "@/lib/logger";
import { isAbortError } from "@/lib/lifecycle";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function getDefaultScanRootPath(): string {
  const home =
    globalThis.window?.recaply?.env?.homeDir ||
    (globalThis as any).process?.env?.HOME;
  if (typeof home === "string" && home.trim()) {
    return `${home.replace(/\/$/, "")}/Downloads/projects`;
  }
  return "/Users";
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const {
    selectedRepos: savedRepos,
    author: savedAuthor,
    updateSettings,
  } = useSettings();

  const [selectedRepos, setSelectedRepos] = useState<string[]>(savedRepos);
  const [author, setAuthor] = useState(savedAuthor);
  const [availableRepos, setAvailableRepos] = useState<RepoInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const scanControllerRef = useRef<AbortController | null>(null);
  const [scanRootPath, setScanRootPath] = useState<string>(() => {
    return (
      localStorage.getItem(STORAGE_KEYS.settings.scanRootPath) ||
      getDefaultScanRootPath()
    );
  });

  // Load available repos when dialog opens
  useEffect(() => {
    if (open) {
      void scanRepos();
      // Sync state with global settings when opening
      setSelectedRepos(savedRepos);
      setAuthor(savedAuthor);
    }
    return () => {
      scanControllerRef.current?.abort();
      scanControllerRef.current = null;
    };
  }, [open]);

  const scanRepos = async () => {
    setScanning(true);
    scanControllerRef.current?.abort();
    const controller = new AbortController();
    scanControllerRef.current = controller;
    try {
      localStorage.setItem(STORAGE_KEYS.settings.scanRootPath, scanRootPath);
      const repos = await scanReposService(scanRootPath, { signal: controller.signal });
      setAvailableRepos(repos);
    } catch (error) {
      if (isAbortError(error)) return;
      logError("settings.scanRepos", error, { scanRootPath });
      toast.error(COPY.toasts.scanReposFailed);
    } finally {
      if (scanControllerRef.current === controller) {
        setScanning(false);
      }
    }
  };

  const toggleRepo = (path: string) => {
    setSelectedRepos((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  const handleSave = () => {
    if (selectedRepos.length === 0) {
      toast.error(COPY.toasts.selectAtLeastOneRepo);
      return;
    }
    updateSettings(selectedRepos, author);
    toast.success(COPY.toasts.settingsSaved);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{COPY.settings.title}</DialogTitle>
          <DialogDescription>
            {COPY.settings.description}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-4 space-y-6">
          {/* Identity Section */}
          <div className="space-y-3">
            <Label>{COPY.common.labels.gitAuthorName}</Label>
            <Input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder={COPY.common.placeholders.authorExample}
            />
            <p className="text-xs text-muted-foreground">
              {COPY.settings.gitAuthorHelp}
            </p>
          </div>

          {/* Repos Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>
                {COPY.settings.repositoriesSelectedLabel(selectedRepos.length)}
              </Label>
              <Button
                variant="outline"
                size="sm"
                onClick={scanRepos}
                disabled={scanning}
              >
                {scanning ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <FolderSearch className="h-3 w-3 mr-1" />
                )}
                {COPY.common.buttons.rescan}
              </Button>
            </div>

            <div className="space-y-2">
              <Label>{COPY.common.labels.scanRootPath}</Label>
              <Input
                value={scanRootPath}
                onChange={(e) => setScanRootPath(e.target.value)}
                placeholder={COPY.common.placeholders.scanRootExample}
              />
              <p className="text-xs text-muted-foreground">
                {COPY.settings.scanRootHelp}
              </p>
            </div>

            <div className="border rounded-md h-60 overflow-hidden relative">
              {scanning && (
                <div className="absolute inset-0 bg-white/80 flex items-center justify-center z-10 transition-opacity duration-300">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="h-6 w-6 animate-spin text-primary" />
                    <span className="text-xs text-muted-foreground">
                      {COPY.settings.scanningDirectories}
                    </span>
                  </div>
                </div>
              )}
              <ScrollArea className="h-full p-2">
                {availableRepos.length === 0 && !scanning ? (
                  <div className="text-center p-8 text-muted-foreground text-sm">
                    {COPY.settings.emptyRepos}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {availableRepos.map((repo) => (
                      <label
                        key={repo.path}
                        className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded cursor-pointer transition-colors text-sm"
                      >
                        <Checkbox
                          checked={selectedRepos.includes(repo.path)}
                          onCheckedChange={() => toggleRepo(repo.path)}
                        />
                        <div className="flex flex-col min-w-0">
                          <span className="font-medium truncate text-slate-700">
                            {repo.name}
                          </span>
                          <span className="text-xs text-slate-400 truncate">
                            {repo.path}
                          </span>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleSave} className="w-full sm:w-auto">
            <Save className="h-4 w-4 mr-2" />
            {COPY.common.buttons.saveConfiguration}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
