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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, Plus } from "lucide-react";
import { RepoSelectionList } from "./RepoSelectionList";
import { toast } from "sonner";
import type { ProfileConfig } from "@/types";

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
              <div className="flex-1">
                <Select
                  value={selectedProfile}
                  onValueChange={(value) => loadConfig(value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择配置" />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((profile) => (
                      <SelectItem key={profile} value={profile}>
                        {profile}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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

            {/* 仓库选择组件 */}
            {config.git.rootPaths.length > 0 && (
              <div className="border rounded-md p-3 bg-slate-50">
                <Label className="mb-2 block">默认选中的仓库</Label>
                <p className="text-xs text-muted-foreground mb-3">
                  选中的仓库会在每次打开应用时自动加载
                </p>
                <div className="bg-white rounded-md border">
                  <RepoSelectionList
                    rootPaths={config.git.rootPaths}
                    selectedRepos={config.git.defaultRepos || []}
                    onSelectionChange={(selected) => {
                      setConfig({
                        ...config,
                        git: {
                          ...config.git,
                          defaultRepos: selected,
                        },
                      });
                    }}
                    scannedRepos={config.git._scannedRepos}
                    onScan={(repos) => {
                      setConfig({
                        ...config,
                        git: {
                          ...config.git,
                          _scannedRepos: repos,
                        },
                      });
                    }}
                  />
                </div>
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
            <Select
              value={config.git.timeMode || "relative"}
              onValueChange={(value) =>
                setConfig({
                  ...config,
                  git: {
                    ...config.git,
                    timeMode: value as "relative" | "absolute",
                  },
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="relative">
                  相对时间 (如 yesterday)
                </SelectItem>
                <SelectItem value="absolute">
                  具体时间 (指定日期时间)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* 相对时间配置 */}
          {config.git.timeMode === "relative" && (
            <>
              <div className="space-y-2">
                <Label>默认开始时间 (相对)</Label>
                <Select
                  value={config.git.since || "yesterday"}
                  onValueChange={(value) =>
                    setConfig({
                      ...config,
                      git: { ...config.git, since: value },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1 hour ago">1 小时前</SelectItem>
                    <SelectItem value="3 hours ago">3 小时前</SelectItem>
                    <SelectItem value="6 hours ago">6 小时前</SelectItem>
                    <SelectItem value="12 hours ago">12 小时前</SelectItem>
                    <SelectItem value="yesterday">昨天</SelectItem>
                    <SelectItem value="2 days ago">2 天前</SelectItem>
                    <SelectItem value="3 days ago">3 天前</SelectItem>
                    <SelectItem value="1 week ago">1 周前</SelectItem>
                    <SelectItem value="2 weeks ago">2 周前</SelectItem>
                    <SelectItem value="1 month ago">1 个月前</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  选择默认的时间范围起点
                </p>
              </div>
              <div className="space-y-2">
                <Label>默认结束时间 (相对,可选)</Label>
                <Select
                  value={config.git.until || "NOW"}
                  onValueChange={(value) =>
                    setConfig({
                      ...config,
                      git: {
                        ...config.git,
                        until: value === "NOW" ? "" : value,
                      },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="当前时间" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NOW">当前时间</SelectItem>
                    <SelectItem value="1 hour ago">1 小时前</SelectItem>
                    <SelectItem value="3 hours ago">3 小时前</SelectItem>
                    <SelectItem value="6 hours ago">6 小时前</SelectItem>
                    <SelectItem value="12 hours ago">12 小时前</SelectItem>
                    <SelectItem value="yesterday">昨天</SelectItem>
                  </SelectContent>
                </Select>
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

          {/* AI 配置 */}
          <div className="space-y-4 border-t pt-4">
            <div>
              <Label className="text-base font-semibold">🤖 AI 模型配置</Label>
              <p className="text-xs text-muted-foreground mt-1">
                为不同的 workflow 节点配置不同的 AI 模型和参数
              </p>
            </div>

            {/* 默认 AI 配置 */}
            <div className="space-y-3 p-3 border rounded-md bg-slate-50">
              <Label className="text-sm font-medium">
                默认配置 (所有节点的 fallback)
              </Label>
              <div className="space-y-2">
                <div>
                  <Label className="text-xs">模型名称 *</Label>
                  <Input
                    value={config.ai?.default?.modelName || ""}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        ai: {
                          ...config.ai,
                          default: {
                            ...config.ai?.default,
                            modelName: e.target.value,
                          },
                        } as any,
                      })
                    }
                    placeholder="claude-opus-4-5-20251101"
                  />
                </div>
                <div>
                  <Label className="text-xs">Base URL</Label>
                  <Input
                    value={config.ai?.default?.baseURL || ""}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        ai: {
                          ...config.ai,
                          default: {
                            ...config.ai?.default,
                            baseURL: e.target.value,
                          },
                        } as any,
                      })
                    }
                    placeholder="https://api.openai.com/v1"
                  />
                </div>
                <div>
                  <Label className="text-xs">API Key</Label>
                  <Input
                    type="password"
                    value={config.ai?.default?.apiKey || ""}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        ai: {
                          ...config.ai,
                          default: {
                            ...config.ai?.default,
                            apiKey: e.target.value,
                          },
                        } as any,
                      })
                    }
                    placeholder="sk-..."
                  />
                </div>
                <div>
                  <Label className="text-xs">Temperature</Label>
                  <Input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={config.ai?.default?.temperature ?? 0.7}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        ai: {
                          ...config.ai,
                          default: {
                            ...config.ai?.default,
                            temperature: parseFloat(e.target.value),
                          },
                        } as any,
                      })
                    }
                  />
                </div>
              </div>
            </div>

            {/* 节点特定配置 (可选) */}
            <details className="space-y-2">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
                高级: 节点特定配置 (可选,点击展开)
              </summary>
              <p className="text-xs text-muted-foreground mb-2">
                为特定节点配置不同的模型。留空则使用默认配置。
              </p>

              {/* Diff Preprocessor */}
              <div className="space-y-2 p-2 border rounded-md">
                <Label className="text-xs font-medium">Diff 预处理器</Label>
                <Input
                  className="text-xs"
                  value={config.ai?.diffPreprocessor?.modelName || ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      ai: {
                        ...config.ai,
                        diffPreprocessor: {
                          ...config.ai?.diffPreprocessor,
                          modelName: e.target.value,
                        },
                      } as any,
                    })
                  }
                  placeholder="留空使用默认配置"
                />
              </div>

              {/* Technical Analyst */}
              <div className="space-y-2 p-2 border rounded-md">
                <Label className="text-xs font-medium">技术分析师</Label>
                <Input
                  className="text-xs"
                  value={config.ai?.technicalAnalyst?.modelName || ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      ai: {
                        ...config.ai,
                        technicalAnalyst: {
                          ...config.ai?.technicalAnalyst,
                          modelName: e.target.value,
                        },
                      } as any,
                    })
                  }
                  placeholder="留空使用默认配置"
                />
              </div>

              {/* Context Analyst */}
              <div className="space-y-2 p-2 border rounded-md">
                <Label className="text-xs font-medium">上下文分析师</Label>
                <Input
                  className="text-xs"
                  value={config.ai?.contextAnalyst?.modelName || ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      ai: {
                        ...config.ai,
                        contextAnalyst: {
                          ...config.ai?.contextAnalyst,
                          modelName: e.target.value,
                        },
                      } as any,
                    })
                  }
                  placeholder="留空使用默认配置"
                />
              </div>

              {/* Synthesizer */}
              <div className="space-y-2 p-2 border rounded-md">
                <Label className="text-xs font-medium">综合器</Label>
                <Input
                  className="text-xs"
                  value={config.ai?.synthesizer?.modelName || ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      ai: {
                        ...config.ai,
                        synthesizer: {
                          ...config.ai?.synthesizer,
                          modelName: e.target.value,
                        },
                      } as any,
                    })
                  }
                  placeholder="留空使用默认配置"
                />
              </div>

              {/* AI Processor (Legacy) */}
              <div className="space-y-2 p-2 border rounded-md">
                <Label className="text-xs font-medium">
                  AI 处理器 (Legacy Mode)
                </Label>
                <Input
                  className="text-xs"
                  value={config.ai?.aiProcessor?.modelName || ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      ai: {
                        ...config.ai,
                        aiProcessor: {
                          ...config.ai?.aiProcessor,
                          modelName: e.target.value,
                        },
                      } as any,
                    })
                  }
                  placeholder="留空使用默认配置"
                />
              </div>
            </details>
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
