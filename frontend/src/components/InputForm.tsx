import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ConfigSelector } from "./ConfigSelector";
import { ProgressDisplay } from "./ProgressDisplay";
import type { WorkflowStep } from "@/types/workflow";

interface InputFormProps {
  onSubmit: (data: {
    userInput: string;
    selectedRepos: string[];
    since?: string;
    until?: string;
  }) => Promise<void>;
  loading: boolean;
  workflowSteps: WorkflowStep[];
}

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
  };
}

export function InputForm({
  onSubmit,
  loading,
  workflowSteps,
}: InputFormProps) {
  const [userInput, setUserInput] = useState("");
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [currentConfig, setCurrentConfig] = useState<ProfileConfig | null>(
    null
  );

  // 当配置变化时,更新默认值
  const handleConfigChange = (config: ProfileConfig) => {
    setCurrentConfig(config);

    // 如果配置有默认仓库,自动设置
    if (config.git.defaultRepos && config.git.defaultRepos.length > 0) {
      setSelectedRepos(config.git.defaultRepos);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // 直接使用配置的时间设置
    let finalSince = "";
    let finalUntil = "";

    if (currentConfig?.git.timeMode === "absolute") {
      // 具体时间模式
      finalSince = currentConfig.git.absoluteSince || "";
      finalUntil = currentConfig.git.absoluteUntil || "";
    } else {
      // 相对时间模式
      finalSince = currentConfig?.git.since || "yesterday";
      finalUntil = currentConfig?.git.until || "";
    }

    console.log(
      "[UI] 准备提交",
      `仓库数量=${selectedRepos.length}, 输入长度=${userInput.length}, since=${finalSince}, until=${finalUntil}`
    );

    await onSubmit({
      userInput,
      selectedRepos,
      since: finalSince,
      until: finalUntil,
    });
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Generate</CardTitle>
        <CardDescription>
          {/* 系统会根据配置自动加载默认仓库和时间设置,您也可以临时修改 */}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* 配置选择器 */}
          <ConfigSelector onConfigChange={handleConfigChange} />

          {/* 显示选中的仓库数量 */}
          {selectedRepos.length > 0 && (
            <div className="text-sm text-muted-foreground">
              已选中 {selectedRepos.length} 个仓库
            </div>
          )}

          {/* 工作笔记 */}

          <div className="space-y-2">
            <Label htmlFor="userInput">今日工作笔记 (可选)</Label>
            <Textarea
              id="userInput"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="例如:完成了用户登录功能,修复了 API 接口的 bug..."
              className="min-h-[100px]"
            />
          </div>

          {/* 进度显示 */}
          {workflowSteps.length > 0 && (
            <ProgressDisplay steps={workflowSteps} currentStep={0} />
          )}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "正在生成总结..." : "生成工作总结"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
