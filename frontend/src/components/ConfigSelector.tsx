import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Settings } from "lucide-react";
import { ConfigDialog } from "./ConfigDialog";
import { toast } from "sonner";
import type { ProfileConfig } from "@/types";

interface ConfigSelectorProps {
  onConfigChange: (config: ProfileConfig) => void;
}

export function ConfigSelector({ onConfigChange }: ConfigSelectorProps) {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [activeProfile, setActiveProfile] = useState<string>("default");
  const [showDialog, setShowDialog] = useState(false);
  const [loading, setLoading] = useState(false);

  // 加载配置列表
  const loadProfiles = async () => {
    try {
      const response = await fetch("http://localhost:3456/api/config/profiles");
      const data = await response.json();
      setProfiles(data.profiles);
      setActiveProfile(data.activeProfile);

      // 加载激活的配置详情
      await loadActiveConfig(data.activeProfile);
    } catch (error) {
      console.error("[ConfigSelector] 加载配置列表失败:", error);
    }
  };

  // 加载激活配置的详细信息
  const loadActiveConfig = async (profileName: string) => {
    try {
      const response = await fetch(
        `http://localhost:3456/api/config/${profileName}`
      );
      const config = await response.json();
      onConfigChange(config);
    } catch (error) {
      console.error("[ConfigSelector] 加载配置详情失败:", error);
    }
  };

  // 切换配置
  const handleProfileChange = async (profileName: string) => {
    setLoading(true);
    try {
      // 切换激活配置
      await fetch("http://localhost:3456/api/config/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileName }),
      });

      setActiveProfile(profileName);
      await loadActiveConfig(profileName);
      console.log(`[ConfigSelector] 切换到配置: ${profileName}`);
    } catch (error) {
      console.error("[ConfigSelector] 切换配置失败:", error);
      toast.error("切换配置失败");
    } finally {
      setLoading(false);
    }
  };

  // 初始加载
  useEffect(() => {
    loadProfiles();
  }, []);

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1">
        <label className="text-sm font-medium mb-1 block">配置 Profile</label>
        <Select
          value={activeProfile}
          onValueChange={handleProfileChange}
          disabled={loading}
        >
          <SelectTrigger className="w-full">
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

      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => setShowDialog(true)}
        className="mt-6"
        title="管理配置"
      >
        <Settings className="h-4 w-4" />
      </Button>

      <ConfigDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        onConfigUpdated={loadProfiles}
      />
    </div>
  );
}
