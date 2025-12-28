/**
 * Year-End Summarizer - Generate comprehensive year-end self-review
 */

import { createLLM, invokeWithRetry } from "../../lib/llm";
import type {
  MonthlySummary,
  WeeklySummary,
  YearEndSummary,
} from "../../lib/types";
import logger from "../../lib/logger";

/**
 * Generate a comprehensive year-end self-review summary
 * Uses both monthly summaries (for structure) and weekly summaries (for details)
 */
export async function processYearEndSummary(
  year: number,
  monthlySummaries: MonthlySummary[],
  weeklySummaries?: WeeklySummary[],
  additionalInstructions?: string
): Promise<YearEndSummary> {
  const startTime = Date.now();

  logger.step("📊", `Year-End Summary - ${year}`, {
    monthsCovered: monthlySummaries.length,
    weeksCovered: weeklySummaries?.length || 0,
  });

  // Build monthly summaries for prompt (宏观结构)
  const monthlySummaryTexts = monthlySummaries.map((m) => {
    return `## ${m.month}\n工作天数: ${m.daysWithWork}\n${m.summary}`;
  });

  // Build weekly summaries grouped by month (细节补充)
  let weeklyDetailsSection = "";
  if (weeklySummaries && weeklySummaries.length > 0) {
    // Group weekly by month
    const weeklyByMonth = new Map<string, WeeklySummary[]>();
    for (const w of weeklySummaries) {
      const month = w.weekStart.substring(0, 7); // YYYY-MM
      if (!weeklyByMonth.has(month)) weeklyByMonth.set(month, []);
      weeklyByMonth.get(month)!.push(w);
    }

    const weeklyTexts: string[] = [];
    const sortedMonths = Array.from(weeklyByMonth.keys()).sort();
    for (const month of sortedMonths) {
      const weeks = weeklyByMonth.get(month)!;
      const weekDetails = weeks
        .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
        .map((w) => `### ${w.weekStart} ~ ${w.weekEnd}\n${w.summary}`)
        .join("\n\n");
      weeklyTexts.push(`## ${month} 周度详情\n${weekDetails}`);
    }
    weeklyDetailsSection = `\n\n---\n\n# 周度工作详情\n以下是按月分组的周度总结，提供更多工作细节：\n\n${weeklyTexts.join(
      "\n\n---\n\n"
    )}`;
  }

  const prompt = `你是一个专业的年度工作总结助手。请根据以下月度工作报告和周度工作详情，生成一份适合用于年度自我评估（Self Review）的年度工作报告。直接输出结果，请勿输出类似于“好的”、“好的，我明白了”等类似内容。

# ${year} 年度工作数据

## 月度概览
以下是每月的工作总结：

${monthlySummaryTexts.join("\n\n---\n\n")}
${weeklyDetailsSection}

## 额外指令
${additionalInstructions ? `> ${additionalInstructions}` : "无"}

## 核心评估维度
请在总结中体现以下维度（这些是公司 Self Review 的评估标准）：
1. **OKR/目标完成**：根据工作内容推断可能完成的主要目标
2. **优势领域**：分析哪些领域表现最突出
3. **协作与可靠性**：跨团队合作、按时高质量交付
4. **问题解决**：系统性思考、解决复杂问题的案例
5. **技术成长**：新技术/方法的学习与应用
6. **领导力与影响力**：指导他人、推动决策（如有）

## 要求
1. 基于事实数据，适度提炼价值，但不过度夸大
2. 成就描述要具体、可衡量（尽量有数据或客观描述）
3. 每个维度都要有具体案例支撑
4. 语言正式但不死板，适合汇报给管理者
5. **不要使用表格格式**，只使用列表和段落
6. **脚踏实地**，不要编造不存在的内容，只基于提供的数据
7. **保留专有名词**（如项目名、技术名、模块名），不要翻译成中文

## 输出格式

# ${year} 年度工作总结

## 📈 年度概述
（2-3 段话总结全年工作，可以适度提炼价值）

## 🎯 OKR/目标完成情况
基于全年工作，推断可能完成的主要目标：
- **目标1**：完成情况
- **目标2**：完成情况

## 🏆 最强表现领域
从全年工作中分析你在哪些领域表现突出（附具体案例）

## 🚀 技术成长
从全年技术实践中总结成长点：
- 技能/技术1
- 技能/技术2

## 🤝 协作与可靠性
从协作记录中归纳跨团队合作、按时交付的例子

## 💡 问题解决案例
从全年工作中挑选 2-3 个最有代表性的问题解决案例

## 👥 领导力与影响力（如有）
识别指导他人、推动决策、分享知识的例子

## 📅 月度亮点一览
- **1月**: 亮点
- **2月**: 亮点
（逐月列出）

## 🎯 总结与展望
（简短的总结和对未来的展望）`;

  const model = createLLM({ temperature: 1.0, tier: "quality" });
  const overview = await invokeWithRetry(model, prompt);

  // Parse achievements
  const achievements: string[] = [];
  const technicalGrowth: string[] = [];
  const challenges: string[] = [];
  const monthlyHighlights: Record<string, string> = {};

  const lines = overview.split("\n");
  let currentSection = "";

  for (const line of lines) {
    if (line.includes("主要成就") || line.includes("Achievements")) {
      currentSection = "achievements";
      continue;
    }
    if (line.includes("技术成长") || line.includes("Technical Growth")) {
      currentSection = "growth";
      continue;
    }
    if (line.includes("挑战") || line.includes("Challenges")) {
      currentSection = "challenges";
      continue;
    }
    if (line.includes("月度亮点") || line.includes("Monthly")) {
      currentSection = "monthly";
      continue;
    }
    if (line.includes("总结") || line.includes("展望")) {
      currentSection = "";
      continue;
    }

    if (currentSection === "achievements" && /^\d+\./.test(line)) {
      achievements.push(line.replace(/^\d+\.\s*/, "").trim());
    }
    if (currentSection === "growth" && line.startsWith("- ")) {
      technicalGrowth.push(line.substring(2).trim());
    }
    if (currentSection === "monthly" && line.includes("**")) {
      const match = line.match(/\*\*(\d+月?)\*\*[：:]\s*(.+)/);
      if (match) {
        monthlyHighlights[match[1]] = match[2].trim();
      }
    }
  }

  const result: YearEndSummary = {
    year,
    overview,
    achievements: achievements.length > 0 ? achievements : ["年度工作稳定推进"],
    technicalGrowth:
      technicalGrowth.length > 0 ? technicalGrowth : ["持续学习提升"],
    challenges: challenges.length > 0 ? challenges : ["克服各项挑战"],
    monthlyHighlights,
  };

  logger.stepDone(`生成 ${overview.length} 字符`, Date.now() - startTime);

  return result;
}
