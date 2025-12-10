import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import summaryRouter from "./routes/summary";
import historyRouter from "./routes/history";
import reposRouter from "./routes/repos";
import { createWorkflowGraph } from "../workflow/graph";
import { generateThreadId } from "../workflow/checkpointer";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3456;

// 中间件
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const start = Date.now();
  const bodyPreview =
    typeof req.body === "object"
      ? JSON.stringify(req.body).slice(0, 300)
      : String(req.body).slice(0, 300);
  console.log(`[HTTP] ${req.method} ${req.originalUrl} body=${bodyPreview}`);
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(
      `[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`
    );
  });
  next();
});

// 路由
app.use("/api", summaryRouter);
app.use("/api", historyRouter);
app.use("/api", reposRouter);

// 健康检查
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

const autoWorkflow = createWorkflowGraph();

function scheduleDailySummary() {
  const autoReposEnv = process.env.AUTO_REPOS;
  if (!autoReposEnv) {
    console.log(
      "[Scheduler] 未配置 AUTO_REPOS（逗号分隔绝对路径），自动汇总任务不启动"
    );
    return;
  }

  const timeOfDay = process.env.AUTO_TIME || "23:59";
  const [hour, minute] = timeOfDay.split(":").map((n) => parseInt(n, 10));
  if (isNaN(hour) || isNaN(minute)) {
    console.warn(`[Scheduler] AUTO_TIME 配置无效: ${timeOfDay}`);
    return;
  }

  const selectedRepos = autoReposEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (selectedRepos.length === 0) {
    console.warn("[Scheduler] AUTO_REPOS 解析后为空，自动任务不启动");
    return;
  }

  const userInput = process.env.AUTO_USER_INPUT || "自动每日汇总";

  const planNextRun = () => {
    const now = new Date();
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    const delay = next.getTime() - now.getTime();
    console.log(
      `[Scheduler] 下次自动汇总时间: ${next.toISOString()}（约 ${(delay / 1000 / 60).toFixed(
        1
      )} 分钟后）`
    );
    setTimeout(async () => {
      await runDailySummary(selectedRepos, userInput);
      planNextRun();
    }, delay);
  };

  planNextRun();
}

async function runDailySummary(selectedRepos: string[], userInput: string) {
  const now = new Date();
  const threadId = generateThreadId(now);
  console.log(
    `[Scheduler] 开始自动汇总 threadId=${threadId}, repos=${selectedRepos.length}`
  );

  try {
    const result = await autoWorkflow.invoke(
      {
        userInput,
        selectedRepos,
      },
      {
        configurable: { thread_id: threadId },
      }
    );

    console.log(
      `[Scheduler] 自动汇总完成 threadId=${threadId}, 输出=${result.outputPath}`
    );
  } catch (error: any) {
    console.error(
      `[Scheduler] 自动汇总失败 threadId=${threadId}:`,
      error?.message,
      error?.stack
    );
  }
}

export default app;

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`);
  scheduleDailySummary();
});
