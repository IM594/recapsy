import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import summaryRouter from "./routes/summary";
import reposRouter from "./routes/repos";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3456;

// 中间件
app.use(cors());
app.use(express.json());

// 简单日志
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
  next();
});

// 路由
app.use("/api", summaryRouter);
app.use("/api", reposRouter);

// 健康检查
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

export default app;

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`);
});
