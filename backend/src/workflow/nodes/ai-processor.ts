import { ChatOpenAI } from "@langchain/openai";
import { WorkflowState } from "../state";
import { progressTracker } from "../../lib/progress-tracker";
import { AI_MODEL_NAME, SUMMARY_TEMPERATURE } from "../../lib/ai-config";

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
  const threadId = state.threadId || "unknown";

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
      modelName: AI_MODEL_NAME,
      temperature: SUMMARY_TEMPERATURE,
    });

    const now = new Date();
    const currentDate = now.toISOString().split("T")[0];
    const currentYear = now.getFullYear();

    // Calculate week number based on 'since' date if available, otherwise use current date
    const targetDate = state.since ? new Date(state.since) : now;
    const targetWeek = getISOWeekNumber(targetDate);

    // Format explicit date range for the prompt
    const sinceStr = state.since || "Start";
    const untilStr = state.until || "End";
    const dateRangeStr = `${sinceStr} - ${untilStr}`;

    const summaryType = state.summaryType || "custom";
    console.log(
      `[AI Processor] 生成总结类型: ${summaryType}, 目标周数: ${targetWeek}, 范围: ${dateRangeStr}`
    );

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
      // Default / Custom
      promptInstructions = `
请生成一份结构化的工作总结，时间范围：${dateRangeStr}。
**风格要求**：
- 面向管理者或非技术人员，语言通俗易懂。
- **不要**直接复制 Git commit message 的格式。
- **重要：请按日期从小到大（升序）排列。**
- **标题**：请使用 "${dateRangeStr} 工作总结" 或类似的包含具体日期的标题，**不要**仅仅使用 "Week X" 这种模糊的标题，除非该时间段确实只包含该周。

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
目标时间范围: ${dateRangeStr}
目标时间范围所属年份: ${targetDate.getFullYear()}
(参考信息: 如果是单周，可能是第 ${targetWeek} 周)

## Git 提交记录
${state.gitCommits || "无"}

## 用户补充说明
${state.userInput || "无"}

## 外部数据
${state.externalData || "无"}

${promptInstructions}

请直接输出 Markdown 格式的总结内容。不要使用 JSON 格式，也不要用 \`\`\`markdown 代码块包裹。直接返回 Markdown 文本。`;

    console.log(`[AI Processor] Prompt 长度: ${prompt.length} 字符`);
    console.log(`[AI Processor] 开始调用 OpenAI API...`);

    const startTime = Date.now();
    const response = await model.invoke(prompt);
    const duration = Date.now() - startTime;

    console.log(`[AI Processor] API 调用完成,耗时: ${duration}ms`);

    const markdownContent = String(response.content);

    // 简单验证一下是否为空
    if (!markdownContent || markdownContent.trim().length === 0) {
      throw new Error("AI 返回的内容为空");
    }

    progressTracker.updateProgress(threadId, {
      step: "aiProcessor",
      status: "completed",
      message: `AI 处理完成`,
      timestamp: Date.now(),
    });

    return {
      processedContent: {
        markdownContent: markdownContent,
      },
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
