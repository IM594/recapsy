import { ChatOpenAI } from "@langchain/openai";
import { WorkflowState } from "../state";
import { progressTracker } from "../../lib/progress-tracker";

const MODEL_NAME = "claude-opus-4-5-20251101";
const TEMPERATURE = 0.7;

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
      modelName: MODEL_NAME,
      temperature: TEMPERATURE,
    });

    const now = new Date();
    const currentDate = now.toISOString().split("T")[0];
    const currentYear = now.getFullYear();

    // Calculate week number based on 'since' date if available, otherwise use current date
    const targetDate = state.since ? new Date(state.since) : now;
    const targetWeek = getISOWeekNumber(targetDate);

    const summaryType = state.summaryType || "custom";
    console.log(
      `[AI Processor] 生成总结类型: ${summaryType}, 目标周数: ${targetWeek}`
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
请生成一份**本周工作总结**。
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
请生成一份结构化的工作总结。
**风格要求**：
- 面向管理者或非技术人员，语言通俗易懂。
- **不要**直接复制 Git commit message 的格式。
- **重要：请按日期从小到大（升序）排列。**

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
目标时间范围所属年份: ${targetDate.getFullYear()}
目标时间范围所属周数: 第 ${targetWeek} 周

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
