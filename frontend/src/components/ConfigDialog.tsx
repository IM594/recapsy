import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Trash2, Plus } from "lucide-react";
import { toast } from "sonner";

interface ProfileConfig {
  name: string;
  git: {
    rootPaths: string[];
    defaultRepos?: string[];
    authorPattern?: string;
    timeMode?: "relative" | "absolute";
    since?: string;
    until?: string;
    absoluteSince?: string;
    absoluteUntil?: string;
    _scannedRepos?: any[]; // 临时存储扫描结果
  };
  output: {
    directory: string;
    format: string;
  };
}

interface ConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigUpdated: () => void;
}

export function ConfigDialog({
  open,
  onOpenChange,
  onConfigUpdated,
}: ConfigDialogProps) {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>("default");
  const [config, setConfig] = useState<ProfileConfig | null>(null);
  const [loading, setLoading] = useState(false);

  // 加载配置列表
  const loadProfiles = async () => {
    try {
      const response = await fetch("http://localhost:3456/api/config/profiles");
      const data = await response.json();
      setProfiles(data.profiles);
      if (data.profiles.length > 0) {
        loadConfig(data.activeProfile || data.profiles[0]);
      }
    } catch (error) {
      console.error("[ConfigDialog] 加载配置列表失败:", error);
    }
  };

  // 加载配置详情
  const loadConfig = async (profileName: string) => {
    try {
      const response = await fetch(
        `http://localhost:3456/api/config/${profileName}`
      );
      const data = await response.json();
      setConfig(data);
      setSelectedProfile(profileName);
    } catch (error) {
      console.error("[ConfigDialog] 加载配置失败:", error);
    }
  };

  // 保存配置
  const handleSave = async () => {
    if (!config) return;

    setLoading(true);
    try {
      await fetch(`http://localhost:3456/api/config/${selectedProfile}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      toast.success("配置保存成功");
      onConfigUpdated();
    } catch (error) {
      console.error("[ConfigDialog] 保存配置失败:", error);
      toast.error("保存配置失败");
    } finally {
      setLoading(false);
    }
  };

  // 删除配置
  const handleDelete = async () => {
    if (selectedProfile === "default") {
      toast.warning("不能删除默认配置");
      return;
    }

    if (!confirm(`确定要删除配置 "${selectedProfile}" 吗?`)) {
      return;
    }

    setLoading(true);
    try {
      await fetch(`http://localhost:3456/api/config/${selectedProfile}`, {
        method: "DELETE",
      });

      toast.success("配置删除成功");
      onConfigUpdated();
      loadProfiles();
    } catch (error) {
      console.error("[ConfigDialog] 删除配置失败:", error);
      toast.error("删除配置失败");
    } finally {
      setLoading(false);
    }
  };

  // 添加根目录
  const handleAddRootPath = () => {
    if (!config) return;
    setConfig({
      ...config,
      git: {
        ...config.git,
        rootPaths: [...config.git.rootPaths, ""],
      },
    });
  };

  // 删除根目录
  const handleRemoveRootPath = (index: number) => {
    if (!config) return;
    setConfig({
      ...config,
      git: {
        ...config.git,
        rootPaths: config.git.rootPaths.filter((_, i) => i !== index),
      },
    });
  };

  // 更新根目录
  const handleUpdateRootPath = (index: number, value: string) => {
    if (!config) return;
    const newRootPaths = [...config.git.rootPaths];
    newRootPaths[index] = value;
    setConfig({
      ...config,
      git: {
        ...config.git,
        rootPaths: newRootPaths,
      },
    });
  };

  useEffect(() => {
    if (open) {
      loadProfiles();
    }
  }, [open]);

  if (!config) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>⚙️ 配置管理</DialogTitle>
          <DialogDescription>
            管理配置 Profile,设置默认的项目路径、仓库和 Git 作者匹配规则
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* 配置选择 */}
          <div className="space-y-2">
            <Label>选择配置 Profile</Label>
            <div className="flex gap-2">
              <select
                className="flex-1 px-3 py-2 text-sm border rounded-md"
                value={selectedProfile}
                onChange={(e) => loadConfig(e.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile} value={profile}>
                    {profile}
                  </option>
                ))}
              </select>
              {selectedProfile !== "default" && (
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  onClick={handleDelete}
                  disabled={loading}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          {/* 配置名称 */}
          <div className="space-y-2">
            <Label>配置名称</Label>
            <Input
              value={config.name}
              onChange={(e) => setConfig({ ...config, name: e.target.value })}
              placeholder="例如: 工作项目"
            />
          </div>

          {/* 项目根目录 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>项目根目录</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddRootPath}
              >
                <Plus className="h-4 w-4 mr-1" />
                添加
              </Button>
            </div>
            <div className="space-y-2">
              {config.git.rootPaths.map((path, index) => (
                <div key={index} className="flex gap-2">
                  <Input
                    value={path}
                    onChange={(e) =>
                      handleUpdateRootPath(index, e.target.value)
                    }
                    placeholder="/Users/username/projects"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemoveRootPath(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* Git 作者匹配 */}
          <div className="space-y-2">
            <Label>Git 作者匹配 (正则表达式)</Label>
            <Input
              value={config.git.authorPattern || ""}
              onChange={(e) =>
                setConfig({
                  ...config,
                  git: { ...config.git, authorPattern: e.target.value },
                })
              }
              placeholder="例如: user|luke"
            />
            <p className="text-xs text-muted-foreground">
              用于过滤 Git 提交记录,支持正则表达式,多个作者用 | 分隔
            </p>
          </div>

          {/* 默认选中的仓库 - 扫描选择 */}
          <div className="space-y-2">
            <Label>默认选中的仓库</Label>
            <p className="text-xs text-muted-foreground mb-2">
              从项目根目录扫描仓库,选中的仓库会在每次打开应用时自动加载
            </p>

            {/* 扫描区域 */}
            {config.git.rootPaths.length > 0 && (
              <div className="border rounded-md p-3 bg-slate-50">
                <div className="flex gap-2 mb-3">
                  <select
                    className="flex-1 px-3 py-2 text-sm border rounded-md bg-white"
                    value={config.git.rootPaths[0] || ""}
                    disabled
                  >
                    <option>
                      {config.git.rootPaths[0] || "请先添加项目根目录"}
                    </option>
                  </select>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      if (!config.git.rootPaths[0]) return;
                      setLoading(true);
                      try {
                        const response = await fetch(
                          `http://localhost:3456/api/repos?rootPath=${encodeURIComponent(
                            config.git.rootPaths[0]
                          )}`
                        );
                        const data = await response.json();
                        // 临时存储扫描结果
                        setConfig({
                          ...config,
                          git: {
                            ...config.git,
                            _scannedRepos: data.repos,
                          },
                        });
                      } catch (error) {
                        console.error("扫描失败:", error);
                        toast.error("扫描仓库失败");
                      } finally {
                        setLoading(false);
                      }
                    }}
                    disabled={loading || !config.git.rootPaths[0]}
                  >
                    {loading ? "扫描中..." : "扫描仓库"}
                  </Button>
                </div>

                {/* 仓库列表 */}
                {config.git._scannedRepos &&
                  config.git._scannedRepos.length > 0 && (
                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                      <p className="text-sm font-medium">
                        选择默认仓库 ({(config.git.defaultRepos || []).length}/
                        {config.git._scannedRepos.length})
                      </p>
                      {config.git._scannedRepos.map((repo: any) => (
                        <label
                          key={repo.path}
                          className="flex items-center space-x-2 p-2 hover:bg-slate-100 rounded cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={(config.git.defaultRepos || []).includes(
                              repo.path
                            )}
                            onChange={(e) => {
                              const currentRepos =
                                config.git.defaultRepos || [];
                              if (e.target.checked) {
                                setConfig({
                                  ...config,
                                  git: {
                                    ...config.git,
                                    defaultRepos: [...currentRepos, repo.path],
                                  },
                                });
                              } else {
                                setConfig({
                                  ...config,
                                  git: {
                                    ...config.git,
                                    defaultRepos: currentRepos.filter(
                                      (p) => p !== repo.path
                                    ),
                                  },
                                });
                              }
                            }}
                            className="rounded"
                          />
                          <span className="text-sm flex-1">{repo.name}</span>
                          <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {repo.path}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
              </div>
            )}

            {config.git.rootPaths.length === 0 && (
              <p className="text-sm text-muted-foreground italic">
                请先添加项目根目录,然后扫描仓库
              </p>
            )}
          </div>

          {/* 时间配置模式 */}
          <div className="space-y-2">
            <Label>时间配置模式</Label>
            <select
              className="w-full px-3 py-2 text-sm border rounded-md"
              value={config.git.timeMode || "relative"}
              onChange={(e) =>
                setConfig({
                  ...config,
                  git: {
                    ...config.git,
                    timeMode: e.target.value as "relative" | "absolute",
                  },
                })
              }
            >
              <option value="relative">相对时间 (如 yesterday)</option>
              <option value="absolute">具体时间 (指定日期时间)</option>
            </select>
          </div>

          {/* 相对时间配置 */}
          {config.git.timeMode === "relative" && (
            <>
              <div className="space-y-2">
                <Label>默认开始时间 (相对)</Label>
                <select
                  className="w-full px-3 py-2 text-sm border rounded-md bg-white"
                  value={config.git.since || "yesterday"}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      git: { ...config.git, since: e.target.value },
                    })
                  }
                >
                  <option value="1 hour ago">1 小时前</option>
                  <option value="3 hours ago">3 小时前</option>
                  <option value="6 hours ago">6 小时前</option>
                  <option value="12 hours ago">12 小时前</option>
                  <option value="yesterday">昨天</option>
                  <option value="2 days ago">2 天前</option>
                  <option value="3 days ago">3 天前</option>
                  <option value="1 week ago">1 周前</option>
                  <option value="2 weeks ago">2 周前</option>
                  <option value="1 month ago">1 个月前</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  选择默认的时间范围起点
                </p>
              </div>
              <div className="space-y-2">
                <Label>默认结束时间 (相对,可选)</Label>
                <select
                  className="w-full px-3 py-2 text-sm border rounded-md bg-white"
                  value={config.git.until || ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      git: { ...config.git, until: e.target.value },
                    })
                  }
                >
                  <option value="">当前时间</option>
                  <option value="1 hour ago">1 小时前</option>
                  <option value="3 hours ago">3 小时前</option>
                  <option value="6 hours ago">6 小时前</option>
                  <option value="12 hours ago">12 小时前</option>
                  <option value="yesterday">昨天</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  通常选择"当前时间"即可
                </p>
              </div>
            </>
          )}

          {/* 具体时间配置 */}
          {config.git.timeMode === "absolute" && (
            <>
              <div className="space-y-2">
                <Label>开始时间</Label>
                <input
                  type="datetime-local"
                  className="w-full px-3 py-2 text-sm border rounded-md"
                  value={config.git.absoluteSince || ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      git: { ...config.git, absoluteSince: e.target.value },
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>结束时间 (可选)</Label>
                <input
                  type="datetime-local"
                  className="w-full px-3 py-2 text-sm border rounded-md"
                  value={config.git.absoluteUntil || ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      git: { ...config.git, absoluteUntil: e.target.value },
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  留空表示当前时间
                </p>
              </div>
            </>
          )}

          {/* 输出目录 */}
          <div className="space-y-2">
            <Label>输出目录</Label>
            <Input
              value={config.output.directory}
              onChange={(e) =>
                setConfig({
                  ...config,
                  output: { ...config.output, directory: e.target.value },
                })
              }
              placeholder="./outputs"
            />
          </div>

          {/* 操作按钮 */}
          <div className="flex justify-end gap-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="button" onClick={handleSave} disabled={loading}>
              {loading ? "保存中..." : "保存配置"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
