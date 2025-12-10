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
import { RepoSelector } from "./RepoSelector";

interface InputFormProps {
  onSubmit: (data: {
    userInput: string;
    selectedRepos: string[];
    since?: string;
    until?: string;
  }) => Promise<void>;
  loading: boolean;
}

export function InputForm({ onSubmit, loading }: InputFormProps) {
  const [userInput, setUserInput] = useState("");
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (since && until && new Date(since) > new Date(until)) {
      alert("开始时间不能晚于结束时间");
      return;
    }
    const normalize = (value: string) =>
      value ? new Date(value).toISOString() : "";
    console.log(
      "[UI] 准备提交",
      `仓库数量=${selectedRepos.length}, 输入长度=${userInput.length}, since=${since ||
        "-"}, until=${until || "-"}`
    );
    await onSubmit({
      userInput,
      selectedRepos,
      since: normalize(since),
      until: normalize(until),
    });
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>📝 输入工作内容</CardTitle>
        <CardDescription>
          手动输入今天完成的任务、遇到的问题或任何笔记。 系统会自动结合 Git
          提交记录和外部数据生成总结。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <RepoSelector
              selectedRepos={selectedRepos}
              onSelectionChange={setSelectedRepos}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="since">开始时间</Label>
              <input
                id="since"
                type="datetime-local"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                不填则默认取过去 24 小时。
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="until">结束时间</Label>
              <input
                id="until"
                type="datetime-local"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                不填则默认取当前时间。
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="userInput">今日工作笔记</Label>
            <Textarea
              id="userInput"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="例如：完成了用户登录功能，修复了 API 接口的 bug..."
              className="min-h-[150px]"
            />
          </div>

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "正在生成总结..." : "生成工作总结"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
