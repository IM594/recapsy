import { WorkflowState } from "../state";
import { progressTracker } from "../../lib/progress-tracker";

/**
 * 用户输入接收器 - 从前端接收数据
 */
export async function collectUserInput(state: WorkflowState) {
  const threadId = state.threadId || "unknown";

  progressTracker.updateProgress(threadId, {
    step: "collectUserInput",
    status: "running",
    message: "正在处理用户输入...",
    timestamp: Date.now(),
  });

  console.log(
    `✍️ [User Input Collector] 接收用户输入，长度: ${
      state.userInput?.length || 0
    }`
  );

  progressTracker.updateProgress(threadId, {
    step: "collectUserInput",
    status: "completed",
    message: `用户输入: ${state.userInput?.length || 0} 字符`,
    timestamp: Date.now(),
  });

  return {};
}
