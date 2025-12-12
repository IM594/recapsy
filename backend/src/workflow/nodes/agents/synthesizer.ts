import { ChatOpenAI } from "@langchain/openai";
import { WorkflowState } from "../../state";
import { progressTracker } from "../../../lib/progress-tracker";
import { AI_MODEL_NAME, SUMMARY_TEMPERATURE } from "../../../lib/ai-config";

/**
 * Synthesizer Agent (Lead Editor)
 * Merges technical and contextual analysis into a final report.
 */
export async function synthesizer(state: WorkflowState) {
  const threadId = state.threadId || "unknown";

  if (!state.deepAnalysis) {
    return { processedContent: {} }; // Should use legacy path if not deep
  }

  // [Sync Fix] Ensure both inputs are ready before synthesizing.
  // In LangGraph parallel branches, this node might be triggered twice (once per branch).
  // We only want to run when we have BOTH parts.
  if (!state.technicalAnalysis || !state.contextualAnalysis) {
    console.log("[Synthesizer] Waiting for all inputs... (Skippin execution)", {
      hasTech: !!state.technicalAnalysis,
      hasContext: !!state.contextualAnalysis,
      deepAnalysis: state.deepAnalysis,
    });
    // Return nothing to indicate "not ready" / no-op for this trigger
    // The conditional edge in graph.ts should handle this by routing to END or staying put.
    return {};
  }

  progressTracker.updateProgress(threadId, {
    step: "synthesizer",
    status: "running",
    message: "🤖 首席编辑正在撰写最终报告...",
    timestamp: Date.now(),
  });

  const prompt = `You are the Lead Editor for a Daily Work Summary generator.
  Your goal is to synthesize inputs from your team (Technical Analyst & Project Manager) into a single, cohesive, high-quality daily report.

  INPUTS:
  ---
  [Technical Analysis (Deep Code Review)]
  ${state.technicalAnalysis}
  ---
  [Contextual Analysis (Business/Tasks)]
  ${state.contextualAnalysis}
  ---
  
  REQUIREMENTS:
  1. Structure the report beautifully in Markdown.
  2. Combine the "What" (Business Context) with the "How" (Technical Details) intelligently.
  3. Do NOT just copy-paste the sections. Weave them together.
  4. Use sections like:
     - 🎯 核心产出 (Core Achievements)
     - 🛠️ 技术细节 (Technical Depth) - cite specific files/logic from technical info
     - 🐛 问题修复 (Bug Fixes)
  5. The audience is a Tech Lead or Engineering Manager who cares about both progress and code quality.
  6. Tone: Professional, confident, concise.
  7. Language: Chinese (Simplified).

  Output the final Markdown content directly.`;

  try {
    // 从 state 获取 AI 配置
    const aiConfig = state.aiConfigs?.["synthesizer"];
    if (!aiConfig) {
      throw new Error("缺少 synthesizer 的 AI 配置");
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
      step: "synthesizer",
      status: "completed",
      message: "✅ 报告撰写完成",
      timestamp: Date.now(),
    });

    // Parse specific fields if needed, or just put everything in markdownContent
    // The legacy exportMarkdown expects 'markdownContent' in processedContent
    return {
      processedContent: {
        markdownContent: content,
      },
    };
  } catch (error) {
    console.error("Synthesizer failed:", error);
    return {
      processedContent: {
        markdownContent: "# Error Generating Report\n\nSynthesizer failed.",
      },
    };
  }
}
