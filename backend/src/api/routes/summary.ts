import { Router, Request, Response } from "express";
import { createWorkflowGraph } from "../../workflow/graph";
import { generateThreadId } from "../../workflow/checkpointer";
import { progressTracker } from "../../lib/progress-tracker";
import { ConfigManager } from "../../lib/config-manager";

const router = Router();
const workflow = createWorkflowGraph();

// SSE 端点 - 实时推送进度
router.get("/progress/:threadId", (req: Request, res: Response) => {
  const { threadId } = req.params;

  // 设置 SSE 头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  console.log(`[SSE] 客户端连接进度流: ${threadId}`);

  // 发送历史进度
  const history = progressTracker.getProgress(threadId);
  history.forEach((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  // 监听新的进度事件
  const progressHandler = (event: any) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  progressTracker.on(`progress:${threadId}`, progressHandler);

  // 客户端断开连接时清理
  req.on("close", () => {
    console.log(`[SSE] 客户端断开连接: ${threadId}`);
    progressTracker.off(`progress:${threadId}`, progressHandler);
    res.end();
  });
});

router.post("/summarize", async (req, res) => {
  try {
    const {
      userInput,
      selectedRepos,
      since,
      until,
      summaryType,
      deepAnalysis,
    } = req.body;

    const threadId = generateThreadId();
    console.log(
      `🚀 开始执行工作流: ${threadId}, 选中的仓库数量: ${
        selectedRepos?.length || 0
      }，用户输入长度: ${userInput?.length || 0}, since=${
        since || "-"
      }, until=${until || "-"}, type=${summaryType || "custom"}, deep=${
        deepAnalysis ? "yes" : "no"
      }`
    );

    // 初始化进度追踪
    progressTracker.startThread(threadId);

    // 立即返回 threadId,让前端连接 SSE
    res.json({
      threadId,
      status: "started",
    });

    // 异步执行工作流
    (async () => {
      try {
        // 加载 AI 配置
        const configManager = ConfigManager.getInstance();
        const aiConfigs = {
          diffPreprocessor: configManager.getAIConfig("diffPreprocessor"),
          aiProcessor: configManager.getAIConfig("aiProcessor"),
          technicalAnalyst: configManager.getAIConfig("technicalAnalyst"),
          contextAnalyst: configManager.getAIConfig("contextAnalyst"),
          synthesizer: configManager.getAIConfig("synthesizer"),
        };

        const result = await workflow.invoke(
          {
            threadId,
            userInput: userInput || "无额外输入",
            selectedRepos: selectedRepos || [],
            since: since || "",
            until: until || "",
            summaryType: summaryType || "custom",
            deepAnalysis: deepAnalysis || false,
            aiConfigs, // 添加 AI 配置
          },
          {
            configurable: { thread_id: threadId },
          }
        );

        // 发送完成事件
        progressTracker.updateProgress(threadId, {
          step: "completed",
          status: "completed",
          message: `输出文件: ${result.outputPath}`,
          summary:
            result.processedContent.markdownContent ||
            JSON.stringify(result.processedContent),
          outputPath: result.outputPath,
          timestamp: Date.now(),
        });

        console.log(
          `✅ 工作流完成: ${threadId}, Markdown 输出: ${result.outputPath}`
        );

        progressTracker.endThread(threadId);
      } catch (error: any) {
        console.error(
          `❌ 工作流执行失败: ${error?.message || "未知错误"} `,
          error?.stack
        );

        // 即使失败也发送完成事件来终止流
        progressTracker.updateProgress(threadId, {
          step: "completed",
          status: "error",
          message: `工作流失败: ${error.message}`,
          isCritical: true,
          timestamp: Date.now(),
        });

        progressTracker.endThread(threadId);
      }
    })();
  } catch (error: any) {
    console.error(
      `❌ 启动工作流失败: ${error?.message || "未知错误"} `,
      error?.stack
    );
    res.status(500).json({ error: error.message });
  }
});

export default router;
