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
        `[Git Collector] 读取仓库: ${repoPath}, since="${since}", until="${
          until || "now"
        }", author="${authorPattern}"`
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

// Helper to calculate ISO week number
function getISOWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

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

    const now = new Date();
    const currentDate = now.toISOString().split("T")[0];
    const currentYear = now.getFullYear();
    const currentWeek = getISOWeekNumber(now);

    const summaryType = state.summaryType || "custom";
    console.log(`[AI Processor] 生成总结类型: ${summaryType}`);

    let promptInstructions = "";

    if (summaryType === "today") {
      promptInstructions = `
请生成一份**今日工作总结**。
重点关注今天完成的事项。
输出结构：
1. **今日事项**：列出今天完成的具体工作项。
2. **今日总结**：简要总结今天的工作成果。
`;
    } else if (summaryType === "week") {
      promptInstructions = `
请生成一份**本周工作总结**。
重点关注本周完成的事项。
**重要：请按日期从小到大（升序）排列。**
输出结构：
1. **本周事项**：
   - 使用 "### YYYYMMDD" 作为标题。
   - 在每个日期下，列出具体的工作项。
2. **本周总结**：总结本周的主要工作成果和进展。
`;
    } else if (summaryType === "month") {
      promptInstructions = `
请生成一份**本月工作总结**。
重点关注本月完成的事项。
**重要：请按日期从小到大（升序）排列。**
输出结构：
1. **本月事项**：
   - 使用 "### YYYYMMDD" 作为标题。
   - 在每个日期下，列出具体的工作项。
2. **本月总结**：
   - **主要工作**：列出本月的主要工作点。
   - **亮点与价值**：列出本月的工作亮点和产生的价值。
`;
    } else {
      // Default / Custom
      promptInstructions = `
请生成一份结构化的工作总结。
**重要：请按日期从小到大（升序）排列。**
输出结构：
1. **按日期分组的详细记录**：
   - 使用 "### YYYYMMDD" 作为标题。
   - 在每个日期下，列出具体的工作项。
2. **总结**：
   - 总结这段时间的主要工作。
`;
    }

    const prompt = `你是一个专业的工作总结助手。请根据以下信息生成一份结构化的工作总结。

当前日期: ${currentDate}
当前年份: ${currentYear}
当前周数: 第 ${currentWeek} 周

## Git 提交记录
${state.gitCommits || "无"}

## 用户补充说明
${state.userInput || "无"}

## 外部数据
${state.externalData || "无"}

${promptInstructions}

请生成一个 JSON 对象，包含一个 "markdownContent" 字段，该字段的值是一个完整的 Markdown 格式的工作总结字符串。
请确保返回的是合法的 JSON 格式，且 "markdownContent" 字段包含完整的 Markdown 文本。`;

    console.log(`[AI Processor] Prompt 长度: ${prompt.length} 字符`);
    console.log(`[AI Processor] 开始调用 OpenAI API...`);

    const startTime = Date.now();
    const response = await model.invoke(prompt);
    const duration = Date.now() - startTime;

    console.log(`[AI Processor] API 调用完成,耗时: ${duration}ms`);

    let parsed;
    try {
      const content = String(response.content);
      // 尝试提取 JSON (可能被包裹在 ```json ... ``` 中)
      const jsonMatch =
        content.match(/```json\s*([\s\S]*?)\s*```/) ||
        content.match(/```\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;

      parsed = JSON.parse(jsonStr.trim());

      if (!parsed.markdownContent) {
        throw new Error("返回的 JSON 中缺少 markdownContent 字段");
      }

      console.log(`[AI Processor] JSON 解析成功`);
    } catch (parseError) {
      console.error(`[AI Processor] JSON 解析失败:`, parseError);
      throw new Error(`AI 返回的内容无法解析为 JSON: ${parseError}`);
    }

    progressTracker.updateProgress(threadId, {
      step: "aiProcessor",
      status: "completed",
      message: `AI 处理完成`,
      timestamp: Date.now(),
    });

    return {
      processedContent: parsed,
    };
  } catch (error: any) {
    console.error("AI 处理失败:", error);
    progressTracker.updateProgress(threadId, {
      step: "aiProcessor",
      status: "error",
      message: "AI 处理失败",
      isCritical: true,
      timestamp: Date.now(),
    });
    return {
      processedContent: {
        markdownContent: "# 处理失败\n\nAI 处理过程中发生错误。",
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

  try {
    const { markdownContent } = state.processedContent || {};

    if (!markdownContent) {
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
    console.log(`[Markdown Exporter] 文件已生成: ${outputPath}`);

    progressTracker.updateProgress(threadId, {
      step: "exportMarkdown",
      status: "completed",
      message: `已生成文件: ${filename}`,
      summary: markdownContent, // 将 markdown 内容传给前端展示
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
