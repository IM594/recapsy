import { ChatOpenAI } from "@langchain/openai";
import { WorkflowState } from "../../state";
import { progressTracker } from "../../../lib/progress-tracker";
import { AI_MODEL_NAME, SUMMARY_TEMPERATURE } from "../../../lib/ai-config";
import { GitDiff } from "../../../lib/git";

/**
 * Technical Analyst Agent
 * Analyzes code diffs to extract technical details.
 */
export async function technicalAnalyst(state: WorkflowState) {
  const threadId = state.threadId || "unknown";

  if (!state.deepAnalysis || !state.gitDiffs) {
    return { technicalAnalysis: "Skipped (Deep Analysis disabled)" };
  }

  progressTracker.updateProgress(threadId, {
    step: "technicalAnalyst",
    status: "running",
    message: "🤖 技术分析师正在深度解读代码变更...",
    timestamp: Date.now(),
  });

  const diffs: GitDiff[] = state.gitDiffs;
  const diffContent = diffs
    .map((d) => `### File: ${d.file}\n${d.diff}`)
    .join("\n\n");

  // Construct prompt
  const prompt = `You are a Senior Tech Lead conducting a code review.
  Analyze the following code diffs to understand EXACTLY what technical changes were made.
  
  Focus on:
  1. Key Logic Changes (what algorithms or flows changed?)
  2. New Features (what distinct valid features were added?)
  3. Bug Fixes (what specific bugs were fixed? Look for 'fix', conditionals, null checks)
  4. Refactoring (architecture changes, dependency injection, etc.)
  5. Breaking Changes (API changes, schema changes)
  
  Do NOT summarize widely known frameworks (e.g. "used React"). Focus on the CUSTOM LOGIC in this project.
  
  DIFF DATA:
  ${diffContent.substring(0, 100000)} ... (Truncated context)
  
  Output a technical summary in Markdown format. Use bullet points. Be concise but specific (mention specific component names or function names if relevant).`;

  try {
    // 从 state 获取 AI 配置
    const aiConfig = state.aiConfigs?.["technicalAnalyst"];
    if (!aiConfig) {
      throw new Error("缺少 technicalAnalyst 的 AI 配置");
    }

    const model = new ChatOpenAI({
      modelName: aiConfig.modelName,
      temperature: aiConfig.temperature,
      openAIApiKey: aiConfig.apiKey,
      configuration: {
        baseURL: aiConfig.baseURL,
      },
    });

    const response = await model.invoke(prompt);
    const content = response.content as string;

    progressTracker.updateProgress(threadId, {
      step: "technicalAnalyst",
      status: "completed",
      message: "✅ 技术分析完成",
      timestamp: Date.now(),
    });

    return {
      technicalAnalysis: content,
    };
  } catch (error) {
    console.error("Technical Analyst failed:", error);
    return { technicalAnalysis: "Analysis Failed" };
  }
}
