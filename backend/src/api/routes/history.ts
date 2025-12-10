import { Router } from "express";
import { createWorkflowGraph } from "../../workflow/graph";

const router = Router();
const workflow = createWorkflowGraph();

// GET /api/history - 获取执行历史
router.get("/history", async (req, res) => {
  try {
    // TODO: Implement actual history listing using checkpointer.list() if available
    // or query the database directly. For MVP, we return empty.
    console.log("[History] 列出历史执行记录（当前返回空数据）");
    res.json({
      executions: [],
    });
  } catch (error: any) {
    console.error("[History] 获取历史失败:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/history/:threadId - 获取特定执行的状态
router.get("/history/:threadId", async (req, res) => {
  try {
    const { threadId } = req.params;
    console.log(`[History] 查询执行记录: ${threadId}`);

    // 从 Workflow 获取状态
    const state = await workflow.getState({
      configurable: { thread_id: threadId },
    });

    if (!state || !state.values) {
      return res.status(404).json({ error: "执行记录不存在" });
    }

    res.json({
      threadId,
      status: "completed", // 简化状态
      result: (state.values as any).processedContent,
      metadata: state.metadata,
    });
  } catch (error: any) {
    console.error(`[History] 查询失败 (${req.params.threadId}):`, error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
