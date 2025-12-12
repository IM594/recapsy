import fs from "fs/promises";
import path from "path";
import { WorkflowState } from "../state";
import { progressTracker } from "../../lib/progress-tracker";

/**
 * Markdown 导出器 - 生成文件
 */
export async function exportMarkdown(state: WorkflowState) {
  const threadId = state.threadId || "unknown";

  progressTracker.updateProgress(threadId, {
    step: "exportMarkdown",
    status: "running",
    message: "正在生成 Markdown 文件...",
    timestamp: Date.now(),
  });

  console.log("📝 [Markdown Exporter] 开始导出 Markdown...");

  try {
    // Debugging: Log available state keys
    console.log("[Markdown Exporter] State Keys:", Object.keys(state));
    console.log(
      "[Markdown Exporter] Processed Content:",
      state.processedContent
    );

    const processedContent = state.processedContent || {};
    const { markdownContent } = processedContent;

    if (!markdownContent) {
      console.error(
        "[Markdown Exporter] Missing content. State dump:",
        JSON.stringify(state, null, 2)
      );
      throw new Error(
        "processedContent.markdownContent 为空 (Content Generation Skipped?)"
      );
    }

    const date = new Date().toISOString().split("T")[0];
    const filename = `summary_${date}.md`;
    const outputPath = path.join(process.cwd(), "outputs", filename);

    // 确保 outputs 目录存在
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    // 添加生成时间注脚
    const finalContent = `${markdownContent}\n\n---\n生成时间: ${new Date().toLocaleString(
      "zh-CN"
    )}\n`;

    await fs.writeFile(outputPath, finalContent, "utf-8");
    console.log(`[Markdown Exporter] 文件已生成: ${outputPath}`);

    progressTracker.updateProgress(threadId, {
      step: "exportMarkdown",
      status: "completed",
      message: `已生成文件: ${filename}`,
      summary: markdownContent,
      outputPath: outputPath,
      timestamp: Date.now(),
    });

    return {
      outputPath,
    };
  } catch (error: any) {
    console.error("导出 Markdown 失败:", error);
    progressTracker.updateProgress(threadId, {
      step: "exportMarkdown",
      status: "error",
      message: "导出 Markdown 失败",
      isCritical: true,
      timestamp: Date.now(),
    });
    return {
      outputPath: "",
    };
  }
}
