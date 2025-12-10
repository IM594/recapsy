import { exec } from "child_process";
import { promisify } from "util";
import { ChatOpenAI } from "@langchain/openai";
import fs from "fs/promises";
import path from "path";
import { WorkflowState } from "./state";

const execAsync = promisify(exec);

// ========== 数据收集节点 ==========

// 1️⃣ Git Commit 收集器 - 运行命令获取 commit
import { getRepoCommits } from "../lib/git";

// 1️⃣ Git Commit 收集器 - 运行命令获取 commit
export async function collectGitCommits(state: WorkflowState) {
  console.log(
    `📦 [Git Collector] 收集 Git commits... 选中仓库: ${
      state.selectedRepos?.length || 0
    }, authorPattern=${process.env.GIT_AUTHOR_PATTERN || "未设置"}`
  );

  try {
    const repos = state.selectedRepos || [];
    const authorPattern = process.env.GIT_AUTHOR_PATTERN || "";
    const since = state.since || process.env.GIT_SINCE || "yesterday";
    const until = state.until || "";

    if (repos.length === 0) {
      return {
        gitCommits: "未选择任何 Git 仓库",
      };
    }

    const commitPromises = repos.map(async (repoPath) => {
      console.log(
        `[Git Collector] 读取仓库: ${repoPath}, since=${since}, until=${until ||
          "now"}, author="${authorPattern}"`
      );
      const commits = await getRepoCommits(repoPath, authorPattern, since, until);
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

    return {
      gitCommits:
        validResults.length > 0
          ? validResults.join("\n\n")
          : "今天没有提交记录",
    };
  } catch (error) {
    console.error("Git 收集失败:", error);
    return {
      gitCommits: "无法获取 Git 记录",
    };
  }
}

// 2️⃣ 用户输入接收器 - 从前端接收数据
export async function collectUserInput(state: WorkflowState) {
  console.log(
    `✍️ [User Input] 接收用户输入... 文本长度: ${
      state.userInput?.length || 0
    }`
  );
  // 实际数据在 invoke 时传入，这里只需返回空对象或保持原样
  return {};
}

// 3️⃣ 外部 API 调用器 - 调用其他应用的 API
export async function collectExternalData(state: WorkflowState) {
  console.log(
    `🌐 [External API] 调用外部 API... 配置 key: ${
      process.env.TODOIST_API_KEY ? "已配置" : "未配置，使用模拟数据"
    }`
  );

  try {
    // 示例: 模拟调用 Todoist API
    // 如果没有 API Key，返回模拟数据
    if (
      !process.env.TODOIST_API_KEY ||
      process.env.TODOIST_API_KEY === "your_todoist_api_key_here"
    ) {
      return {
        externalData:
          "（模拟数据）完成任务：\n- 更新架构文档\n- 初始化项目结构",
      };
    }

    const response = await fetch("https://api.todoist.com/rest/v2/tasks", {
      headers: {
        Authorization: `Bearer ${process.env.TODOIST_API_KEY}`,
      },
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.statusText}`);
    }

    const tasks: any[] = await response.json();
    console.log(`[External API] 获取到任务数量: ${tasks.length}`);
    const completedToday = tasks
      // 简单过滤，实际可能需要查询 completed items API
      .map((task: any) => task.content)
      .join("\n");

    return {
      externalData: completedToday || "今天没有完成的任务",
    };
  } catch (error) {
    console.error("外部 API 调用失败:", error);
    return {
      externalData: "无法获取外部数据",
    };
  }
}

// ========== AI 处理节点 ==========

// 4️⃣ AI 汇总处理器 - 汇总所有数据并生成结构化内容
export async function aiProcessor(state: WorkflowState) {
  console.log(
    `🤖 [AI Processor] AI 处理中... git长度: ${
      state.gitCommits?.length || 0
    }, 输入长度: ${state.userInput?.length || 0}, 外部数据长度: ${
      state.externalData?.length || 0
    }`
  );

  const llm = new ChatOpenAI({
    modelName: "claude-opus-4-5-20251101",
    temperature: 0.7,
    configuration: {
      baseURL: process.env.OPENAI_BASE_URL,
    },
  });

  const prompt = `
你是一个专业的工作总结助手。请根据以下信息生成一份结构化的工作总结。

## 今日 Git 提交记录
${state.gitCommits}

## 用户手动输入
${state.userInput}

## 外部系统数据
${state.externalData}

请以 JSON 格式返回，包含以下字段：
{
  "summary": "一句话总结今天的工作",
  "achievements": ["成就1", "成就2", ...],
  "challenges": ["挑战1", "挑战2", ...],
  "nextSteps": ["明天要做的事1", "明天要做的事2", ...]
}

请确保返回的是有效的 JSON 格式，不要包含 Markdown 代码块标记（如 \`\`\`json）。
`;

  const response = await llm.invoke(prompt);
  const content = response.content as string;

  // 提取 JSON (处理可能的 markdown 代码块)
  let jsonStr = content;
  const jsonMatch =
    content.match(/```json\n([\s\S]*?)\n```/) ||
    content.match(/```\n([\s\S]*?)\n```/) ||
    content.match(/\{[\s\S]*\}/);

  if (jsonMatch) {
    jsonStr = jsonMatch[1] || jsonMatch[0];
  }

  try {
    const processedContent = JSON.parse(jsonStr);
    console.log("[AI Processor] AI 返回已解析");
    return {
      processedContent,
    };
  } catch (e) {
    console.error("JSON 解析失败:", e);
    // Fallback
    return {
      processedContent: {
        summary: "无法解析 AI 返回的内容",
        achievements: [],
        challenges: ["AI 返回格式错误"],
        nextSteps: [],
      },
    };
  }
}

// ========== 输出节点 ==========

// 5️⃣ Markdown 导出器 - 生成 Markdown 文件
export async function exportMarkdown(state: WorkflowState) {
  console.log(
    "📝 [Markdown Exporter] 导出 Markdown...",
    `summary长度: ${state.processedContent?.summary?.length || 0}`
  );

  const { processedContent } = state;
  const date = new Date().toISOString().split("T")[0];

  // 生成 Markdown 内容
  const markdown = `# 工作总结 - ${date}

## 📊 今日概览
${processedContent.summary}

## 🎯 主要成就
${processedContent.achievements.map((item: string) => `- ${item}`).join("\n")}

## 💪 遇到的挑战
${processedContent.challenges.map((item: string) => `- ${item}`).join("\n")}

## 📅 明日计划
${processedContent.nextSteps.map((item: string) => `- ${item}`).join("\n")}

---
*生成时间: ${new Date().toLocaleString("zh-CN")}*
`;

  // 保存文件
  const outputDir = path.join(process.cwd(), "outputs");
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `summary-${date}.md`);
  await fs.writeFile(outputPath, markdown, "utf-8");

  console.log(`✅ Markdown 已保存: ${outputPath}`);

  return {
    outputPath,
  };
}
