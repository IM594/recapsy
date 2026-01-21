import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import summaryRouter from "./routes/summary";
import reposRouter from "./routes/repos";

dotenv.config();

const DEBUG_STARTUP = process.env.DEBUG_STARTUP === "1";

function flag(value: unknown): string {
  return value ? "yes" : "no";
}

if (DEBUG_STARTUP) {
  console.log("======================================");
  console.log("LLM Configuration");
  console.log("  Fallback:");
  console.log(`    AI_MODEL_NAME: ${process.env.AI_MODEL_NAME || "(unset)"}`);
  console.log(`    OPENAI_BASE_URL: ${flag(process.env.OPENAI_BASE_URL)}`);
  console.log(`    OPENAI_API_KEY: ${flag(process.env.OPENAI_API_KEY)}`);
  console.log("  Fast (Daily):");
  console.log(`    AI_MODEL_FAST: ${process.env.AI_MODEL_FAST || "(fallback)"}`);
  console.log(`    AI_BASEURL_FAST: ${flag(process.env.AI_BASEURL_FAST)}`);
  console.log("  Balanced (Weekly):");
  console.log(
    `    AI_MODEL_BALANCED: ${process.env.AI_MODEL_BALANCED || "(fallback)"}`
  );
  console.log(`    AI_BASEURL_BALANCED: ${flag(process.env.AI_BASEURL_BALANCED)}`);
  console.log("  Quality (Monthly/Yearly):");
  console.log(
    `    AI_MODEL_QUALITY: ${process.env.AI_MODEL_QUALITY || "(fallback)"}`
  );
  console.log(`    AI_BASEURL_QUALITY: ${flag(process.env.AI_BASEURL_QUALITY)}`);
  console.log("======================================");
}

const app = express();
const PORT = (() => {
  const parsed = Number.parseInt(process.env.PORT || "", 10);
  return Number.isFinite(parsed) ? parsed : 3456;
})();

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Simple request logging (avoid spamming for SSE)
app.use((req, res, next) => {
  if (!req.originalUrl.includes("/api/summary/events")) {
    console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
  }
  next();
});

// Routes
app.use("/api/summary", summaryRouter);
app.use("/api", reposRouter);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// Export app for potential tests
export default app;

// Server instance
let server: ReturnType<typeof app.listen> | null = null;

// Start server
export function startServer(port?: number): Promise<number> {
  return new Promise((resolve) => {
    const actualPort = port || PORT;
    server = app.listen(actualPort, () => {
      console.log(`Server listening at http://localhost:${actualPort}`);
      resolve(actualPort);
    });
  });
}

// Stop server
export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        console.log("Server stopped");
        server = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// Start server when invoked directly
if (require.main === module) {
  startServer();
}
