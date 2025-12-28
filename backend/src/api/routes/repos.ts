import { Router } from "express";
import { findRepositories } from "../../lib/git";

const router = Router();

router.get("/repos", async (req, res) => {
  try {
    const rootPath = req.query.rootPath as string;
    const rootDir = rootPath || process.env.PROJECTS_ROOT;

    if (!rootDir) {
      return res.status(400).json({ error: "Root path is required" });
    }

    console.log(`[Repos] 开始扫描根目录: ${rootDir}`);
    const repos = await findRepositories(rootDir);
    console.log(`[Repos] 扫描完成，发现仓库数量: ${repos.length}`);
    res.json({ repos });
  } catch (error: any) {
    console.error("[Repos] 扫描失败:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
