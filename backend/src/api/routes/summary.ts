import { Router } from "express";
import { createWorkflowGraph } from "../../workflow/graph";
import logger from "../../lib/logger";

const router = Router();
const workflow = createWorkflowGraph();

/**
 * POST /api/summarize
 * 生成工作总结
 */
router.post("/summarize", async (req, res) => {
  const startTime = Date.now();

  try {
    const { selectedRepos, since, until, summaryType } = req.body;

    const typeLabels: Record<string, string> = {
      today: "今日总结",
      week: "本周总结",
      month: "本月总结",
    };

    logger.taskStart("工作流执行", {
      任务类型: typeLabels[summaryType] || summaryType || "today",
      仓库数量: selectedRepos?.length || 0,
      时间范围: `${since || "default"} → ${until || "now"}`,
    });

    const result = await workflow.invoke({
      selectedRepos: selectedRepos || [],
      since: since || "",
      until: until || "",
      summaryType: summaryType || "today",
    });

    const duration = Date.now() - startTime;
    logger.taskEnd("工作流执行", duration, result.outputPath);

    res.json({
      status: "completed",
      summary: result.processedContent?.markdownContent || "",
      outputPath: result.outputPath || "",
    });
  } catch (error: any) {
    logger.taskError("工作流执行", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
