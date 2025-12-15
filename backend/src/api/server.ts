import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import summaryRouter from "./routes/summary";
import reposRouter from "./routes/repos";
import workflowRouter from "./routes/workflow";
import regenerateRouter from "./routes/regenerate";

dotenv.config();

// 调试：输出环境变量加载情况
console.log("══════════════════════════════════════");
console.log("📋 环境变量加载状态:");
console.log(`   AI_MODEL_NAME: ${process.env.AI_MODEL_NAME || "(未设置)"}`);
console.log(
  `   OPENAI_BASE_URL: ${process.env.OPENAI_BASE_URL ? "已设置" : "(未设置)"}`
);
console.log(
  `   OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "已设置" : "(未设置)"}`
);
console.log("══════════════════════════════════════");

const app = express();
const PORT = process.env.PORT || 3456;

// 中间件
app.use(cors());
app.use(express.json({ limit: "50mb" })); // 增加请求体大小限制以支持大量数据

// 简单日志
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
  next();
});

// 路由
app.use("/api", summaryRouter);
app.use("/api", reposRouter);
app.use("/api/workflow", workflowRouter);
app.use("/api", regenerateRouter);

// 健康检查
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

export default app;

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`);
});
