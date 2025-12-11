import { Router, Request, Response } from "express";
import { ConfigManager } from "../../lib/config-manager";
import { ProfileConfig } from "../../lib/config-types";

const router = Router();
const configManager = ConfigManager.getInstance();

/**
 * GET /api/config
 * 获取所有配置
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const config = configManager.getAllConfig();
    res.json(config);
  } catch (error: any) {
    console.error("[Config API] 获取配置失败:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/config/profiles
 * 获取所有 Profile 名称列表
 */
router.get("/profiles", async (req: Request, res: Response) => {
  try {
    const profiles = configManager.getProfileNames();
    const activeProfile = configManager.getAllConfig().activeProfile;
    res.json({ profiles, activeProfile });
  } catch (error: any) {
    console.error("[Config API] 获取 Profile 列表失败:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/config/:profileName
 * 获取指定配置 Profile
 */
router.get("/:profileName", async (req: Request, res: Response) => {
  try {
    const { profileName } = req.params;
    const profile = configManager.getProfile(profileName);
    res.json(profile);
  } catch (error: any) {
    console.error(
      `[Config API] 获取配置 ${req.params.profileName} 失败:`,
      error
    );
    res.status(404).json({ error: error.message });
  }
});

/**
 * POST /api/config
 * 创建新的配置 Profile
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, config } = req.body as {
      name: string;
      config: ProfileConfig;
    };

    if (!name || !config) {
      return res.status(400).json({ error: "缺少必要参数: name, config" });
    }

    await configManager.createProfile(name, config);
    res.json({ success: true, message: `配置 Profile "${name}" 创建成功` });
  } catch (error: any) {
    console.error("[Config API] 创建配置失败:", error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/config/:profileName
 * 更新配置 Profile
 */
router.put("/:profileName", async (req: Request, res: Response) => {
  try {
    const { profileName } = req.params;
    const config = req.body as Partial<ProfileConfig>;

    await configManager.updateProfile(profileName, config);
    res.json({
      success: true,
      message: `配置 Profile "${profileName}" 更新成功`,
    });
  } catch (error: any) {
    console.error(
      `[Config API] 更新配置 ${req.params.profileName} 失败:`,
      error
    );
    res.status(400).json({ error: error.message });
  }
});

/**
 * DELETE /api/config/:profileName
 * 删除配置 Profile
 */
router.delete("/:profileName", async (req: Request, res: Response) => {
  try {
    const { profileName } = req.params;
    await configManager.deleteProfile(profileName);
    res.json({
      success: true,
      message: `配置 Profile "${profileName}" 删除成功`,
    });
  } catch (error: any) {
    console.error(
      `[Config API] 删除配置 ${req.params.profileName} 失败:`,
      error
    );
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/config/active
 * 切换激活的配置 Profile
 */
router.post("/active", async (req: Request, res: Response) => {
  try {
    const { profileName } = req.body as { profileName: string };

    if (!profileName) {
      return res.status(400).json({ error: "缺少必要参数: profileName" });
    }

    await configManager.setActiveProfile(profileName);
    res.json({
      success: true,
      message: `已切换到配置 Profile "${profileName}"`,
    });
  } catch (error: any) {
    console.error("[Config API] 切换激活配置失败:", error);
    res.status(400).json({ error: error.message });
  }
});

export default router;
