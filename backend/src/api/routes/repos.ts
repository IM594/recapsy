import { Router } from "express";
import { findRepositories } from "../../lib/git";
import logger from "../../lib/logger";
import { getConfig } from "../../config";
import { API_ROUTES, QUERY_KEYS } from "@recaply/shared";
import { asyncHandler } from "../middleware/async-handler";
import { badRequest } from "../../lib/errors";

const router = Router();

router.get(
  API_ROUTES.repos,
  asyncHandler(async (req, res) => {
    const rootPath = req.query[QUERY_KEYS.rootPath] as string;
    const rootDir = rootPath || getConfig().repos.defaultRootPath;

    if (!rootDir) {
      throw badRequest("Root path is required", { query: req.query });
    }

    logger.step("🔎", "Scanning repositories", { rootDir });
    const startedAt = Date.now();
    const repos = await findRepositories(rootDir);
    logger.stepDone(`Found ${repos.length} repositories`, Date.now() - startedAt);
    res.json({ repos });
  })
);

export default router;
