import { ChatOpenAI } from "@langchain/openai";
import { WorkflowState } from "../../state";
import { progressTracker } from "../../../lib/progress-tracker";
import { AI_MODEL_NAME } from "../../../lib/ai-config";

/**
 * Context Analyst Agent
 * Analyzes high-level context from commit messages, user input, and external data.
 */
export async function contextAnalyst(state: WorkflowState) {
  const threadId = state.threadId || "unknown";

  if (!state.deepAnalysis) {
    return { contextualAnalysis: "Skipped" };
  }

  progressTracker.updateProgress(threadId, {
    step: "contextAnalyst",
    status: "running",
    message: "🤖 项目经理正在梳理业务背景...",
    timestamp: Date.now(),
  });

  // Construct prompt
  const prompt = `You are a Project Manager. Analyze the following project activity to understand the "Big Picture".
  
  SOURCES:
  1. User Input (Daily Notes): ${state.userInput || "None"}
  2. Git Commit Messages: ${state.gitCommits || "None"}
  3. External Data (Jira/Todo): ${state.externalData || "None"}
  
  GOAL:
  Identify the high-level tasks and business value delivered.
  - What was the main focus today?
  - Which tickets/tasks were completed?
  - Any blockers or non-technical challenges mentioned?
  
  Output a contextual summary in Markdown. Be professional.`;

  try {
    // 从 state 获取 AI 配置
    const aiConfig = state.aiConfigs?.["contextAnalyst"];
    if (!aiConfig) {
      throw new Error("缺少 contextAnalyst 的 AI 配置");
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
      step: "contextAnalyst",
      status: "completed",
      message: "✅ 上下文分析完成",
      timestamp: Date.now(),
    });

    return {
      contextualAnalysis: content,
    };
  } catch (error) {
    console.error("Context Analyst failed:", error);
    return { contextualAnalysis: "Analysis Failed" };
  }
}
