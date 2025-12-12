import { WorkflowState } from "../state";
import { progressTracker } from "../../lib/progress-tracker";

/**
 * 外部 API 调用器 - 调用其他应用的 API（如 Todoist）
 */
export async function collectExternalData(state: WorkflowState) {
  const threadId = state.threadId || "unknown";

  progressTracker.updateProgress(threadId, {
    step: "collectExternalData",
    status: "running",
    message: "正在调用外部 API...",
    timestamp: Date.now(),
  });

  console.log("🌐 [External Data Collector] 收集外部数据...");

  const todoistApiKey = process.env.TODOIST_API_KEY;
  if (!todoistApiKey) {
    console.log("[External Data Collector] 未配置 TODOIST_API_KEY，跳过");
    progressTracker.updateProgress(threadId, {
      step: "collectExternalData",
      status: "completed",
      message: "未配置外部 API,已跳过",
      timestamp: Date.now(),
    });
    return {
      externalData: "未配置外部 API",
      collectorProgress: ["external_api"],
    };
  }

  try {
    const response = await fetch("https://api.todoist.com/rest/v2/tasks", {
      headers: {
        Authorization: `Bearer ${todoistApiKey}`,
      },
    });

    if (!response.ok) {
      console.error(
        `[External Data Collector] Todoist API 请求失败: ${response.status}`
      );
      progressTracker.updateProgress(threadId, {
        step: "collectExternalData",
        status: "error",
        message: "外部 API 请求失败",
        isCritical: false,
        timestamp: Date.now(),
      });
      return {
        externalData: "外部 API 请求失败",
        collectorProgress: ["external_api"],
      };
    }

    const tasks = await response.json();
    console.log(
      `[External Data Collector] 获取到 ${tasks.length} 个 Todoist 任务`
    );

    const taskList = tasks
      .slice(0, 10)
      .map((t: any) => `- ${t.content}`)
      .join("\n");

    progressTracker.updateProgress(threadId, {
      step: "collectExternalData",
      status: "completed",
      message: `成功获取 ${tasks.length} 个任务`,
      timestamp: Date.now(),
    });

    return {
      externalData: "External Data: None (Mock)",
      collectorProgress: ["external_api"],
    };
  } catch (error) {
    console.error("[External Data Collector] 外部数据收集失败:", error);
    progressTracker.updateProgress(threadId, {
      step: "collectExternalData",
      status: "error",
      message: "外部数据收集失败",
      isCritical: false,
      timestamp: Date.now(),
    });
    return {
      externalData: "外部数据收集失败",
      collectorProgress: ["external_api"],
    };
  }
}
