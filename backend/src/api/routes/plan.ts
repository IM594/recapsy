import { Router, Request, Response } from "express";
import { ChatOpenAI } from "@langchain/openai";
import { AI_MODEL_NAME, PARSING_TEMPERATURE } from "../../lib/ai-config";

const router = Router();

router.post("/plan", async (req: Request, res: Response) => {
  try {
    const { command } = req.body;

    if (!command) {
      res.status(400).json({ error: "Command is required" });
      return;
    }

    const model = new ChatOpenAI({
      modelName: AI_MODEL_NAME,
      temperature: PARSING_TEMPERATURE,
    });

    const now = new Date();
    const currentTime = now.toLocaleString("zh-CN", { hour12: false });
    const currentISO = now.toISOString();

    const prompt = `
You are a smart assistant for a work summarization tool.
Your task is to parse a natural language command from the user and convert it into structured parameters for generating a work summary.

Current Time: ${currentTime} (ISO: ${currentISO})

User Command: "${command}"

Please extract/infer the following parameters:
1. "since": The start date/time for the summary (YYYY-MM-DD HH:MM:SS). If not specified, infer from context (e.g., "today" -> today 00:00:00).
2. "until": The end date/time for the summary (YYYY-MM-DD HH:MM:SS). If not specified, usually defaults to "now".
3. "summaryType": One of "today", "week", "month", "custom". Infer based on the requested range.
   - If the range is exactly today, use "today".
   - If the range is exactly this week, use "week".
   - If the range is exactly this month, use "month".
   - Otherwise, use "custom".
4. "focus": A brief description of what to focus on (e.g., "bugs", "features", "everything"). Defaults to "everything" if not specified.

Return ONLY a valid JSON object with these fields. Do not include markdown formatting.
Example JSON:
{
  "since": "2025-12-01 00:00:00",
  "until": "2025-12-05 23:59:59",
  "summaryType": "custom",
  "focus": "features related to login"
}
`;

    console.log(`[Plan API] Analyzing command: "${command}"`);
    const response = await model.invoke(prompt);
    const content = String(response.content).trim();

    // Clean up potential markdown code blocks
    const jsonStr = content.replace(/^```json\s*|\s*```$/g, "");

    let plan;
    try {
      plan = JSON.parse(jsonStr);
    } catch (e) {
      console.error("[Plan API] Failed to parse LLM response:", content);
      throw new Error("Failed to parse plan from AI response");
    }

    console.log("[Plan API] Generated plan:", plan);
    res.json(plan);
  } catch (error: any) {
    console.error("[Plan API] Error:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

export default router;
