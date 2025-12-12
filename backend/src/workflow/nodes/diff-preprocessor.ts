import { ChatOpenAI } from "@langchain/openai";
import { WorkflowState } from "../state";
import { progressTracker } from "../../lib/progress-tracker";
import { GitDiff } from "../../lib/git";
import { AI_MODEL_NAME } from "../../lib/ai-config";

// Use a cheaper/faster model for summarization if possible,
// but for now we default to the same model generic config or hardcode a lighter one if env var exists.
const SUMMARIZER_MODEL = "claude-opus-4-5-20251101"; // Or claude-3-haiku, assuming supported

/**
 * Diff Preprocessor - Summarizes large diffs
 */
export async function diffPreprocessor(state: WorkflowState) {
  const threadId = state.threadId || "unknown";

  if (!state.deepAnalysis || !state.gitDiffs || state.gitDiffs.length === 0) {
    return { gitDiffs: state.gitDiffs }; // Pass through
  }

  const rawDiffs: GitDiff[] = state.gitDiffs;

  // Thresholds
  const MAX_TOTAL_TOKENS = 30000;
  const FILE_TOKEN_THRESHOLD = 2000;

  // Calculate total tokens
  const totalTokens = rawDiffs.reduce((sum, item) => sum + item.tokenCount, 0);

  if (totalTokens <= MAX_TOTAL_TOKENS) {
    console.log(
      `[Diff Preprocessor] Total tokens ${totalTokens} within limit. Passing raw diffs.`
    );
    return { gitDiffs: rawDiffs };
  }

  console.log(
    `[Diff Preprocessor] Total tokens ${totalTokens} exceeds limit. Summarizing large files...`
  );

  progressTracker.updateProgress(threadId, {
    step: "diffPreprocessor",
    status: "running",
    message: "Diff 数据过大，正在进行智能压缩...",
    timestamp: Date.now(),
  });

  // 从 state 获取 AI 配置
  const aiConfig = state.aiConfigs?.["diffPreprocessor"];
  if (!aiConfig) {
    throw new Error("缺少 diffPreprocessor 的 AI 配置");
  }

  // Initialize LLM for summarization
  const model = new ChatOpenAI({
    modelName: aiConfig.modelName,
    temperature: aiConfig.temperature,
    openAIApiKey: aiConfig.apiKey,
    configuration: {
      baseURL: aiConfig.baseURL,
    },
  });

  const processedDiffs: GitDiff[] = [];

  // Process files
  // Sort by token count desc handled in git.ts, but let's ensure
  const sortedDiffs = [...rawDiffs].sort((a, b) => b.tokenCount - a.tokenCount);

  for (const item of sortedDiffs) {
    if (item.tokenCount > FILE_TOKEN_THRESHOLD) {
      // Summarize this file
      try {
        console.log(
          `[Diff Preprocessor] Summarizing ${item.file} (${item.tokenCount} tokens)...`
        );
        const response = await model.invoke(
          `You are a Senior Technical Lead. Summarize the code changes in the following git diff for file '${
            item.file
          }'.
            Focus on LOGIC changes, new features, and bug fixes.
            Ignore formatting/whitespace changes.
            Keep it concise (under 200 words).
            
            DIFF CONTENT:
            ${item.diff.substring(0, 15000)} ... (Truncated if too long)
            `
        );

        processedDiffs.push({
          file: item.file,
          diff: `[AI SUMMARIZED DIFF]\n${response.content as string}`,
          tokenCount: 200, // Estimate summary size
        });
      } catch (err) {
        console.error(`Failed to summarize ${item.file}`, err);
        processedDiffs.push({
          file: item.file,
          diff: "[Error Summarizing Diff]",
          tokenCount: 50,
        });
      }
    } else {
      // Keep raw
      processedDiffs.push(item);
    }
  }

  progressTracker.updateProgress(threadId, {
    step: "diffPreprocessor",
    status: "completed",
    message: `Diff 预处理完成 (压缩后 tokens: ${processedDiffs.reduce(
      (a, b) => a + b.tokenCount,
      0
    )})`,
    timestamp: Date.now(),
  });

  return {
    gitDiffs: processedDiffs,
  };
}
