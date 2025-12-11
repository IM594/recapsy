import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Repo {
  name: string;
  path: string;
}

interface RepoSelectionListProps {
  rootPaths: string[];
  selectedRepos: string[];
  onSelectionChange: (selected: string[]) => void;
  scannedRepos?: Repo[]; // Externally provided scanned repos (optional)
  onScan?: (repos: Repo[]) => void; // Callback when internal scan completes
}

export function RepoSelectionList({
  rootPaths,
  selectedRepos,
  onSelectionChange,
  scannedRepos: externalScannedRepos,
  onScan,
}: RepoSelectionListProps) {
  const [internalScannedRepos, setInternalScannedRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Use external repos if provided, otherwise internal
  const repos = externalScannedRepos || internalScannedRepos;

  // Scan repositories if not provided externally and we have root paths
  const scanRepos = async () => {
    if (rootPaths.length === 0) return;
    setLoading(true);
    try {
      const allRepos: Repo[] = [];
      // Support scanning multiple root paths
      for (const rootPath of rootPaths) {
        if (!rootPath) continue;
        const response = await fetch(
          `http://localhost:3456/api/repos?rootPath=${encodeURIComponent(
            rootPath
          )}`
        );
        const data = await response.json();
        if (data.repos) {
          allRepos.push(...data.repos);
        }
      }

      // Deduplicate by path
      const uniqueRepos = Array.from(
        new Map(allRepos.map((item) => [item.path, item])).values()
      );

      setInternalScannedRepos(uniqueRepos);
      if (onScan) onScan(uniqueRepos);
    } catch (error) {
      console.error("Scanning failed:", error);
      toast.error("扫描仓库失败");
    } finally {
      setLoading(false);
    }
  };

  const filteredRepos = repos.filter((repo) =>
    repo.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleSelectAll = () => {
    onSelectionChange(filteredRepos.map((r) => r.path));
  };

  const handleSelectNone = () => {
    onSelectionChange([]);
  };

  return (
    <div className="space-y-4">
      {/* Header / Controls */}
      <div className="flex flex-col gap-2">
        {/* If we are managing scanning here */}
        {!externalScannedRepos && (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={scanRepos}
              disabled={loading || rootPaths.length === 0}
              className="w-full"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  扫描中...
                </>
              ) : (
                "扫描仓库"
              )}
            </Button>
          </div>
        )}

        {repos.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="搜索仓库..."
                className="pl-8 h-9"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSelectAll}
                className="h-9 px-2 text-xs"
              >
                全选
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSelectNone}
                className="h-9 px-2 text-xs"
              >
                清空
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Repo List */}
      <div className="border rounded-md bg-slate-50 overflow-hidden">
        {repos.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {loading ? "扫描中..." : "暂无仓库，请先扫描或添加根目录"}
          </div>
        ) : (
          <ScrollArea className="h-[250px]">
            <div className="p-2 space-y-1">
              {filteredRepos.length === 0 && (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  无匹配仓库
                </div>
              )}
              {filteredRepos.map((repo) => (
                <label
                  key={repo.path}
                  className="flex items-center space-x-3 p-2 hover:bg-slate-100 rounded-md cursor-pointer group transition-colors"
                >
                  <Checkbox
                    checked={selectedRepos.includes(repo.path)}
                    onCheckedChange={(checked) => {
                      const isChecked = checked === true;
                      if (isChecked) {
                        onSelectionChange([...selectedRepos, repo.path]);
                      } else {
                        onSelectionChange(
                          selectedRepos.filter((p) => p !== repo.path)
                        );
                      }
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-700 group-hover:text-slate-900">
                      {repo.name}
                    </div>
                    <div
                      className="text-xs text-slate-400 font-mono truncate"
                      title={repo.path}
                    >
                      {repo.path}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Footer Info */}
      <div className="flex justify-between text-xs text-muted-foreground px-1">
        <span>已选择 {selectedRepos.length} 个仓库</span>
        <span>共 {repos.length} 个仓库</span>
      </div>
    </div>
  );
}
