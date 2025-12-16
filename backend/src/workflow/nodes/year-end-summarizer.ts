/**
 * Year-End Summarizer - Generate comprehensive year-end self-review
 */

import { createLLM, invokeWithRetry } from "../../lib/llm";
import type { MonthlySummary, YearEndSummary } from "../../lib/types";
import logger from "../../lib/logger";

/**
 * Generate a comprehensive year-end self-review summary
 */
export async function processYearEndSummary(
  year: number,
  monthlySummaries: MonthlySummary[],
  additionalInstructions?: string
): Promise<YearEndSummary> {
  const startTime = Date.now();

  logger.step("📊", `Year-End Summary - ${year}`, {
    monthsCovered: monthlySummaries.length,
  });

  // Build monthly summaries for prompt
  const monthlySummaryTexts = monthlySummaries.map((m) => {
    return `## ${m.month}\n工作天数: ${m.daysWithWork}\n${m.summary}`;
  });

  const prompt = `你是一个专业的年度工作总结助手。请根据以下月度工作总结，生成一份适合用于年度自我评估（Self Review）的年度工作报告。

# ${year} 年度工作数据

${monthlySummaryTexts.join("\n\n---\n\n")}

## 额外指令
${additionalInstructions ? `> ${additionalInstructions}` : "无"}

## 要求
1. **年度概述**：用 2-3 段话概述全年的工作重点和成果
2. **主要成就**：列出 5-8 项年度主要成就，要具体、可衡量
3. **技术成长**：总结技术能力的提升和学习
4. **挑战与克服**：描述遇到的主要挑战以及如何解决
5. **月度亮点**：每个月用一句话总结最重要的工作

## 输出格式

# ${year} 年度工作总结

## 📈 年度概述
（2-3 段话）

## 🏆 主要成就
1. 成就1（具体描述）
2. 成就2（具体描述）
...

## 🚀 技术成长
- 技能1
- 技能2
...

## 💪 挑战与克服
（描述主要挑战和解决过程）

## 📅 月度亮点
- **1月**: 亮点
- **2月**: 亮点
...

## 🎯 总结与展望
（简短的总结和对未来的展望）`;

  const model = createLLM({ temperature: 0.6 });
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
