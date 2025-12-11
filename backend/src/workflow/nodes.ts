import { exec } from "child_process";
import { promisify } from "util";
import { ChatOpenAI } from "@langchain/openai";
import fs from "fs/promises";
import path from "path";
import { WorkflowState } from "./state";
import { ConfigManager } from "../lib/config-manager";
import { progressTracker } from "../lib/progress-tracker";

const execAsync = promisify(exec);

// ========== 数据收集节点 ==========

// 1️⃣ Git Commit 收集器 - 运行命令获取 commit
import { getRepoCommits } from "../lib/git";

// 1️⃣ Git Commit 收集器 - 运行命令获取 commit
export async function collectGitCommits(state: WorkflowState) {
  const threadId = state.threadId || "unknown";

  progressTracker.updateProgress(threadId, {
    step: "collectGitCommits",
    status: "running",
    message: `正在收集 ${state.selectedRepos?.length || 0} 个仓库的提交记录...`,
    timestamp: Date.now(),
  });

  const configManager = ConfigManager.getInstance();
  const config = configManager.getActiveProfile();

  console.log(
    `📦 [Git Collector] 收集 Git commits... 选中仓库: ${
      state.selectedRepos?.length || 0
    }, authorPattern=${config.git.authorPattern || "未设置"}`
  );

  try {
    const repos = state.selectedRepos || [];
    const authorPattern = config.git.authorPattern || "";
    const since = state.since || config.git.since || "yesterday";
    const until = state.until || "";

    if (repos.length === 0) {
      progressTracker.updateProgress(threadId, {
        step: "collectGitCommits",
        status: "completed",
        message: "未选择任何仓库",
        timestamp: Date.now(),
      });
      return {
        gitCommits: "未选择任何 Git 仓库",
      };
    }

    const commitPromises = repos.map(async (repoPath) => {
      console.log(
        `[Git Collector] 读取仓库: ${repoPath}, since=${since}, until=${
          until || "now"
        }, author="${authorPattern}"`
      );
      const commits = await getRepoCommits(
        repoPath,
        authorPattern,
        since,
        until
      );

      console.log(
        `[Git Collector] ${repoPath} 获取到 ${
          commits ? commits.split("\n").length : 0
        } 条记录`
      );
      if (!commits) return null;
      const repoName = path.basename(repoPath);
      return `### ${repoName}\n${commits}`;
    });

    const results = await Promise.all(commitPromises);
    const validResults = results.filter((r) => r !== null);

    progressTracker.updateProgress(threadId, {
      step: "collectGitCommits",
      status: "completed",
      message: `成功收集 ${validResults.length} 个仓库的提交记录`,
      timestamp: Date.now(),
    });

    return {
      gitCommits:
        validResults.length > 0
          ? validResults.join("\n\n")
          : "今天没有提交记录",
    };
  } catch (error) {
    console.error("Git 收集失败:", error);
    progressTracker.updateProgress(threadId, {
      step: "collectGitCommits",
      status: "error",
      message: "Git 收集失败",
      isCritical: true, // Git 收集失败是致命的
      timestamp: Date.now(),
    });
    return {
      gitCommits: "无法获取 Git 记录",
    };
  }
}

// 2️⃣ 用户输入接收器 - 从前端接收数据
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

// 3️⃣ 外部 API 调用器 - 调用其他应用的 API
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
        isCritical: false, // 外部 API 失败不是致命的
        timestamp: Date.now(),
      });
      return {
        externalData: "外部 API 请求失败",
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
      externalData: taskList || "无待办事项",
    };
  } catch (error) {
    console.error("[External Data Collector] 外部数据收集失败:", error);
    progressTracker.updateProgress(threadId, {
      step: "collectExternalData",
      status: "error",
      message: "外部数据收集失败",
      isCritical: false, // 外部数据收集失败不是致命的
      timestamp: Date.now(),
    });
    return {
      externalData: "外部数据收集失败",
    };
  }
}

// ========== AI 处理节点 ==========

// 4️⃣ AI 处理器 - 调用 LLM 分析数据
export async function aiProcessor(state: WorkflowState) {
  const threadId = state.threadId || "unknown";
  const MODEL_NAME = "claude-opus-4-5-20251101";
  const TEMPERATURE = 0.7;

  progressTracker.updateProgress(threadId, {
    step: "aiProcessor",
    status: "running",
    message: "正在调用 AI 分析数据...",
    timestamp: Date.now(),
  });

  console.log(
    `🤖 [AI Processor] 开始 AI 处理... gitCommits 长度: ${
      state.gitCommits?.length || 0
    }, userInput 长度: ${state.userInput?.length || 0}`
  );

  try {
    const model = new ChatOpenAI({
      modelName: MODEL_NAME,
      temperature: TEMPERATURE,
    });

    console.log(
      `[AI Processor] 模型配置: modelName=${MODEL_NAME}, temperature=${TEMPERATURE}`
    );
    console.log(
      `[AI Processor] OpenAI Base URL: ${
        process.env.OPENAI_BASE_URL || "default"
      }`
    );

    const prompt = `你是一个专业的工作总结助手。请根据以下信息生成一份结构化的工作总结:

## Git 提交记录
${state.gitCommits || "无"}

## 用户补充说明
${state.userInput || "无"}

## 外部数据
${state.externalData || "无"}

请生成一个 JSON 对象,包含以下字段:
- summary: 工作总结的主要内容(字符串)
- achievements: 主要成就列表(字符串数组)
- nextSteps: 下一步计划(字符串数组,可选)

只返回 JSON,不要其他内容。`;

    console.log(`[AI Processor] Prompt 长度: ${prompt.length} 字符`);
    console.log(`[AI Processor] 开始调用 OpenAI API...`);

    const startTime = Date.now();
    const response = await model.invoke(prompt);
    const duration = Date.now() - startTime;

    console.log(`[AI Processor] API 调用完成,耗时: ${duration}ms`);
    console.log(`[AI Processor] 响应类型: ${typeof response.content}`);
    console.log(
      `[AI Processor] 响应长度: ${String(response.content).length} 字符`
    );
    console.log(
      `[AI Processor] 响应内容预览: ${String(response.content).substring(
        0,
        200
      )}...`
    );

    let parsed;
    try {
      const content = String(response.content);
      // 尝试提取 JSON (可能被包裹在 ```json ... ``` 中)
      const jsonMatch =
        content.match(/```json\s*([\s\S]*?)\s*```/) ||
        content.match(/```\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;

      console.log(`[AI Processor] 提取的 JSON 字符串长度: ${jsonStr.length}`);
      parsed = JSON.parse(jsonStr.trim());
      console.log(`[AI Processor] JSON 解析成功`);
      console.log(
        `[AI Processor] 解析结果包含字段: ${Object.keys(parsed).join(", ")}`
      );
    } catch (parseError) {
      console.error(`[AI Processor] JSON 解析失败:`, parseError);
      console.error(`[AI Processor] 原始响应内容:`, String(response.content));
      throw new Error(`AI 返回的内容无法解析为 JSON: ${parseError}`);
    }

    progressTracker.updateProgress(threadId, {
      step: "aiProcessor",
      status: "completed",
      message: `AI 处理完成,生成了 ${parsed.achievements?.length || 0} 项成就`,
      timestamp: Date.now(),
    });

    console.log(`[AI Processor] 处理完成,返回结果`);
    return {
      processedContent: parsed,
    };
  } catch (error: any) {
    console.error("AI 处理失败:", error);
    console.error("错误堆栈:", error.stack);
    console.error("错误详情:", JSON.stringify(error, null, 2));
    progressTracker.updateProgress(threadId, {
      step: "aiProcessor",
      status: "error",
      message: "AI 处理失败",
      isCritical: true, // AI 处理失败是致命的
      timestamp: Date.now(),
    });
    return {
      processedContent: {
        summary: "处理失败",
        achievements: [],
        challenges: [],
        nextSteps: [],
      },
    };
  }
}

// ========== 输出节点 ==========

// 5️⃣ Markdown 导出器 - 生成文件
export async function exportMarkdown(state: WorkflowState) {
  const threadId = state.threadId || "unknown";

  progressTracker.updateProgress(threadId, {
    step: "exportMarkdown",
    status: "running",
    message: "正在生成 Markdown 文件...",
    timestamp: Date.now(),
  });

  console.log("📝 [Markdown Exporter] 开始导出 Markdown...");
  console.log(
    `[Markdown Exporter] state.processedContent:`,
    state.processedContent
  );
  console.log(
    `[Markdown Exporter] processedContent 类型: ${typeof state.processedContent}`
  );

  try {
    const summary = state.processedContent;

    if (!summary) {
      throw new Error("processedContent 为空或 undefined");
    }

    console.log(
      `[Markdown Exporter] summary 对象:`,
      JSON.stringify(summary, null, 2)
    );
    console.log(
      `[Markdown Exporter] summary.achievements 存在: ${!!summary.achievements}`
    );
    console.log(
      `[Markdown Exporter] summary.achievements 类型: ${typeof summary.achievements}`
    );

    const date = new Date().toISOString().split("T")[0];
    const filename = `summary_${date}.md`;
    const outputPath = path.join(process.cwd(), "outputs", filename);

    // 确保 outputs 目录存在
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const content = `# 工作总结 - ${date}

## 总结
${summary.summary || "无"}

## 主要成就
${summary.achievements?.map((item: string) => `- ${item}`).join("\n") || "无"}

## 下一步计划
${summary.nextSteps?.map((item: string) => `- ${item}`).join("\n") || "无"}

---
生成时间: ${new Date().toLocaleString("zh-CN")}
`;

    await fs.writeFile(outputPath, content, "utf-8");
    console.log(`[Markdown Exporter] 文件已生成: ${outputPath}`);

    progressTracker.updateProgress(threadId, {
      step: "exportMarkdown",
      status: "completed",
      message: `已生成文件: ${filename}`,
      timestamp: Date.now(),
    });

    return {
      outputPath,
    };
  } catch (error: any) {
    console.error("导出 Markdown 失败:", error);
    console.error("错误堆栈:", error.stack);
    progressTracker.updateProgress(threadId, {
      step: "exportMarkdown",
      status: "error",
      message: "导出 Markdown 失败",
      isCritical: true, // 导出失败是致命的
      timestamp: Date.now(),
    });
    return {
      outputPath: "",
    };
  }
}
