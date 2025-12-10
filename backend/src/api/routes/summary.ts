import { Router } from "express";
import { createWorkflowGraph } from "../../workflow/graph";
import { generateThreadId } from "../../workflow/checkpointer";

const router = Router();
const workflow = createWorkflowGraph();

router.post("/summarize", async (req, res) => {
  try {
    const { userInput, selectedRepos, since, until } = req.body; // 前端传来的用户输入

    const threadId = generateThreadId();
    console.log(
      `🚀 开始执行工作流: ${threadId}, 选中的仓库数量: ${
        selectedRepos?.length || 0
      }，用户输入长度: ${userInput?.length || 0}, since=${since || "-"}, until=${
        until || "-"
      }`
    );

    // 执行工作流
    const result = await workflow.invoke(
      {
        userInput: userInput || "无额外输入",
        selectedRepos: selectedRepos || [],
        since: since || "",
        until: until || "",
      },
      {
        configurable: { thread_id: threadId },
      }
    );

    res.json({
      threadId,
      summary: result.processedContent,
      outputPath: result.outputPath,
      status: "completed",
    });
    console.log(
      `✅ 工作流完成: ${threadId}, Markdown 输出: ${result.outputPath}`
    );
  } catch (error: any) {
    console.error(
      `❌ 工作流执行失败: ${error?.message || "未知错误"} `,
      error?.stack
    );
    res.status(500).json({ error: error.message });
  }
});

export default router;
