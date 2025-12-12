import fs from "fs/promises";
import path from "path";
import { WorkflowState } from "../state";
import logger from "../../lib/logger";

/**
 * Markdown 导出器 - 生成文件
 */
export async function exportMarkdown(state: WorkflowState) {
  const startTime = Date.now();

  logger.step("📝", "Markdown Exporter - 生成文件");

  const processedContent = state.processedContent || {};
  const { markdownContent } = processedContent;

  if (!markdownContent) {
    logger.error("缺少 markdownContent");
    throw new Error("processedContent.markdownContent 为空");
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

  logger.stepDone(
    `${filename} (${finalContent.length} 字符)`,
    Date.now() - startTime
  );

  return {
    outputPath,
    summary: markdownContent,
  };
}
