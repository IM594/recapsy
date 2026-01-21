import { Router } from "express";
import { findRepositories } from "../../lib/git";
import logger from "../../lib/logger";

const router = Router();

router.get("/repos", async (req, res) => {
  try {
    const rootPath = req.query.rootPath as string;
    const rootDir = rootPath || process.env.PROJECTS_ROOT;

    if (!rootDir) {
      return res.status(400).json({ error: "Root path is required" });
    }

    logger.step("🔎", "Scanning repositories", { rootDir });
    const startedAt = Date.now();
    const repos = await findRepositories(rootDir);
    logger.stepDone(`Found ${repos.length} repositories`, Date.now() - startedAt);
    res.json({ repos });
  } catch (error: any) {
    logger.error("Repository scan failed", error);
    res.status(500).json({ error: error.message ?? "Failed to scan repositories" });
  }
});

export default router;
