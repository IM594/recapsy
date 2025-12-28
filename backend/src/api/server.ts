import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import summaryRouter from "./routes/summary";
import reposRouter from "./routes/repos";

dotenv.config();

// 调试：输出环境变量加载情况
console.log("══════════════════════════════════════");
console.log("📋 LLM 配置状态:");
console.log("   🔹 Fallback:");
console.log(`      AI_MODEL_NAME: ${process.env.AI_MODEL_NAME || "(未设置)"}`);
console.log(
  `      OPENAI_BASE_URL: ${process.env.OPENAI_BASE_URL ? "✓" : "✗"}`
);
console.log(`      OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "✓" : "✗"}`);
console.log("   🚀 Fast (Daily):");
console.log(
  `      AI_MODEL_FAST: ${process.env.AI_MODEL_FAST || "(fallback)"}`
);
console.log(
  `      AI_BASEURL_FAST: ${process.env.AI_BASEURL_FAST ? "✓" : "(fallback)"}`
);
console.log("   ⚖️  Balanced (Weekly):");
console.log(
  `      AI_MODEL_BALANCED: ${process.env.AI_MODEL_BALANCED || "(fallback)"}`
);
console.log(
  `      AI_BASEURL_BALANCED: ${
    process.env.AI_BASEURL_BALANCED ? "✓" : "(fallback)"
  }`
);
console.log("   🎯 Quality (Monthly/Yearly):");
console.log(
  `      AI_MODEL_QUALITY: ${process.env.AI_MODEL_QUALITY || "(fallback)"}`
);
console.log(
  `      AI_BASEURL_QUALITY: ${
    process.env.AI_BASEURL_QUALITY ? "✓" : "(fallback)"
  }`
);
console.log("══════════════════════════════════════");

const app = express();
const PORT = process.env.PORT || 3456;

// 中间件
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// 简单日志
app.use((req, res, next) => {
  // SSE 连接保持长连接，打印日志太频繁，忽略
  if (!req.originalUrl.includes("/api/summary/events")) {
    console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
  }
  next();
});

// 路由
app.use("/api/summary", summaryRouter);
app.use("/api", reposRouter);

// 健康检查
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// 导出 app 供测试使用
export default app;

// 服务器实例，供外部调用
let server: ReturnType<typeof app.listen> | null = null;

// 启动服务器函数
export function startServer(port?: number): Promise<number> {
  return new Promise((resolve) => {
    const actualPort = port || PORT;
    server = app.listen(actualPort, () => {
      console.log(`🚀 服务器运行在 http://localhost:${actualPort}`);
      resolve(actualPort);
    });
  });
}

// 停止服务器函数
export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        console.log("🛑 服务器已停止");
        server = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// 直接运行时启动服务器（兼容原有启动方式）
if (require.main === module) {
  startServer();
}
