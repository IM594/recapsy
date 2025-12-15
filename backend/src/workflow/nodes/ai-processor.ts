import { ChatOpenAI } from "@langchain/openai";
import { WorkflowState } from "../state";
import logger from "../../lib/logger";

/**
 * 计算 ISO 周数
 */
function getISOWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * AI 处理器 - 调用 LLM 分析数据
 */
export async function aiProcessor(state: WorkflowState) {
  const startTime = Date.now();

  const now = new Date();
  const currentDate = now.toISOString().split("T")[0];
  const targetDate = state.since ? new Date(state.since) : now;
  const targetWeek = getISOWeekNumber(targetDate);
  const summaryType = state.summaryType || "today";

  const typeLabels: Record<string, string> = {
    today: "今日总结",
    week: `本周总结 (W${targetWeek})`,
    month: "本月总结",
  };

  // 在运行时读取环境变量,确保 dotenv 已加载
  const AI_MODEL = process.env.AI_MODEL_NAME;
  const AI_BASE_URL = process.env.OPENAI_BASE_URL;
  const AI_API_KEY = process.env.OPENAI_API_KEY;
  const AI_TEMPERATURE = 0.7;

  logger.step("🤖", "AI Processor - 调用 LLM 分析", {
    总结类型: typeLabels[summaryType] || summaryType,
    模型: AI_MODEL,
    输入长度: `${state.gitCommits?.length || 0} 字符`,
  });

  const model = new ChatOpenAI({
    modelName: AI_MODEL,
    temperature: AI_TEMPERATURE,
    openAIApiKey: AI_API_KEY,
    configuration: {
      baseURL: AI_BASE_URL,
    },
  });

  const sinceStr = state.since || "Start";
  const untilStr = state.until || "End";
  const dateRangeStr = `${sinceStr} - ${untilStr}`;

  let promptInstructions = "";

  if (summaryType === "today") {
    promptInstructions = `
请生成一份**今日工作总结**。
**风格要求**：
- 面向管理者或非技术人员，语言通俗易懂。
- **不要**直接复制 Git commit message 的格式（如 "feat(bot):..."），请将其转化为自然语言描述。
- 将相关的细碎提交合并为一个完整的工作项。

输出结构：
1. **今日事项**：列出今天完成的具体工作项。
2. **今日总结**：简要总结今天的工作成果。
`;
  } else if (summaryType === "week") {
    promptInstructions = `
请生成一份**本周工作总结** (第 ${targetWeek} 周)。
**风格要求**：
- 面向管理者或非技术人员，语言通俗易懂。
- **不要**直接复制 Git commit message 的格式（如 "feat(bot):..."），请将其转化为自然语言描述。
- **重点在于归纳和总结**，而不是罗列流水账。将相关的技术细节合并为高层级的功能点或成就。
- **重要：请按日期从小到大（升序）排列。**

输出结构：
1. **本周事项**：
   - 使用 "### YYYYMMDD" 作为标题。
   - 在每个日期下，列出具体的工作项（经过润色和合并的）。
2. **本周总结**：总结本周的主要工作成果和进展。
`;
  } else if (summaryType === "month") {
    promptInstructions = `
请生成一份**本月工作总结**。
**风格要求**：
- 面向管理者或非技术人员，语言通俗易懂。
- **不要**直接复制 Git commit message 的格式。
- **高度概括**：忽略琐碎的 bug 修复和重构细节，专注于主要功能的交付和业务价值。
- **重要：请按日期从小到大（升序）排列。**

输出结构：
1. **本月事项**：
   - 使用 "### YYYYMMDD" 作为标题。
   - 在每个日期下，列出具体的工作项。
2. **本月总结**：
   - **主要工作**：列出本月的主要工作点。
   - **亮点与价值**：列出本月的工作亮点和产生的价值。
`;
  } else {
    promptInstructions = `
请生成一份结构化的工作总结，时间范围：${dateRangeStr}。
**风格要求**：
- 面向管理者或非技术人员，语言通俗易懂。
- **不要**直接复制 Git commit message 的格式。
- **重要：请按日期从小到大（升序）排列。**

输出结构：
1. **按日期分组的详细记录**：
   - 使用 "### YYYYMMDD" 作为标题。
   - 在每个日期下，列出具体的工作项。
2. **总结**：总结这段时间的主要工作。
`;
  }

  const prompt = `你是一个专业的工作总结助手。请根据以下信息生成一份结构化的工作总结。

当前日期: ${currentDate}
目标时间范围: ${dateRangeStr}
目标时间范围所属年份: ${targetDate.getFullYear()}
(参考信息: 如果是单周，可能是第 ${targetWeek} 周)

## Git 提交记录
${state.gitCommits || "无"}

${promptInstructions}

请直接输出 Markdown 格式的总结内容。不要使用 JSON 格式，也不要用 \`\`\`markdown 代码块包裹。直接返回 Markdown 文本。`;

  logger.debug("Prompt 长度", `${prompt.length} 字符`);
  logger.info("正在调用 API...");

  const apiStart = Date.now();
  const response = await model.invoke(prompt);
  const apiDuration = Date.now() - apiStart;

  const markdownContent = String(response.content);

  if (!markdownContent || markdownContent.trim().length === 0) {
    throw new Error("AI 返回的内容为空");
  }

  logger.stepDone(`生成 ${markdownContent.length} 字符`, apiDuration);

  return {
    processedContent: {
      markdownContent: markdownContent,
    },
  };
}
