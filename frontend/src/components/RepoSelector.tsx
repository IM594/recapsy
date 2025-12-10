import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, FolderOpen } from "lucide-react";

interface Repo {
  name: string;
  path: string;
}

interface RepoSelectorProps {
  selectedRepos: string[];
  onSelectionChange: (repos: string[]) => void;
}

export function RepoSelector({
  selectedRepos,
  onSelectionChange,
}: RepoSelectorProps) {
  const [rootPath, setRootPath] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRepos = async () => {
    if (!rootPath.trim()) {
      setError("请输入项目根目录路径");
      return;
    }

    setLoading(true);
    setError(null);
    setRepos([]);
    console.log("[UI] 开始扫描仓库", rootPath);

    try {
      const response = await fetch(
        `http://localhost:3456/api/repos?rootPath=${encodeURIComponent(
          rootPath
        )}`
      );
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Failed to fetch repositories");
      }
      const data = await response.json();
      setRepos(data.repos);
      console.log("[UI] 扫描完成, 获取仓库数:", data.repos.length);
      if (data.repos.length === 0) {
        setError("该目录下未找到 Git 仓库");
      }
    } catch (err: any) {
      setError(err.message || "无法加载仓库列表");
      console.error("[UI] 扫描仓库失败:", err);
    } finally {
      setLoading(false);
    }
  };

  const toggleRepo = (path: string) => {
    console.log("[UI] 切换仓库选择", path);
    if (selectedRepos.includes(path)) {
      onSelectionChange(selectedRepos.filter((p) => p !== path));
    } else {
      onSelectionChange([...selectedRepos, path]);
    }
  };

  return (
    <div className="space-y-4 border rounded-md p-4 bg-slate-50/50">
      <div className="space-y-2">
        <Label>项目根目录 (Projects Root)</Label>
        <div className="flex gap-2">
          <input
            type="text"
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            placeholder="粘贴文件夹路径,例如: /Users/username/projects"
            className="flex-1 px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Button
            type="button"
            onClick={fetchRepos}
            disabled={loading}
            variant="secondary"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FolderOpen className="h-4 w-4" />
            )}
            <span className="ml-2">扫描</span>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          💡 提示: 在 Finder 中右键点击文件夹,按住 Option 键,选择"拷贝路径名称"
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      {repos.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>
              选择 Git 仓库 ({selectedRepos.length}/{repos.length})
            </Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto py-0 text-xs"
              onClick={() => {
                if (selectedRepos.length === repos.length) {
                  onSelectionChange([]);
                } else {
                  onSelectionChange(repos.map((r) => r.path));
                }
              }}
            >
              {selectedRepos.length === repos.length ? "取消全选" : "全选"}
            </Button>
          </div>

          <ScrollArea className="h-[200px] w-full border rounded-md bg-white p-2">
            <div className="space-y-2">
              {repos.map((repo) => (
                <div
                  key={repo.path}
                  className="flex items-center space-x-2 p-1 hover:bg-slate-100 rounded"
                >
                  <Checkbox
                    id={repo.path}
                    checked={selectedRepos.includes(repo.path)}
                    onCheckedChange={() => toggleRepo(repo.path)}
                  />
                  <Label
                    htmlFor={repo.path}
                    className="text-sm font-normal cursor-pointer flex-1 truncate"
                  >
                    {repo.name}
                    <span className="text-xs text-muted-foreground ml-2 truncate opacity-50">
                      {repo.path.replace(rootPath, "...")}
                    </span>
                  </Label>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
