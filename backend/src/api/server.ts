import express from "express";
import cors from "cors";
import fs from "fs";
import summaryRouter from "./routes/summary";
import reposRouter from "./routes/repos";
import { getConfig } from "../config";
import { ENV_KEYS } from "../config/constants";
import { LLM_ENV_KEYS } from "../config/llm-env";
import { API_MOUNTS } from "@recaply/shared";
import logger from "../lib/logger";
import { requestIdMiddleware } from "./middleware/request-id";
import { errorHandler } from "./middleware/error-handler";

const config = getConfig();

const DEBUG_STARTUP = process.env[ENV_KEYS.debugStartup] === "1";

function flag(value: unknown): string {
  return value ? "yes" : "no";
}

if (DEBUG_STARTUP) {
  console.log("======================================");
  console.log("LLM Configuration");
  console.log("  Fallback:");
  console.log(
    `    ${LLM_ENV_KEYS.modelName}: ${
      process.env[LLM_ENV_KEYS.modelName] || "(unset)"
    }`
  );
  console.log(
    `    ${LLM_ENV_KEYS.openaiBaseUrl}: ${flag(
      process.env[LLM_ENV_KEYS.openaiBaseUrl]
    )}`
  );
  console.log(
    `    ${LLM_ENV_KEYS.openaiApiKey}: ${flag(
      process.env[LLM_ENV_KEYS.openaiApiKey]
    )}`
  );
  console.log("  Fast (Daily):");
  console.log(
    `    ${LLM_ENV_KEYS.modelFast}: ${
      process.env[LLM_ENV_KEYS.modelFast] || "(fallback)"
    }`
  );
  console.log(
    `    ${LLM_ENV_KEYS.baseUrlFast}: ${flag(
      process.env[LLM_ENV_KEYS.baseUrlFast]
    )}`
  );
  console.log("  Balanced (Weekly):");
  console.log(
    `    ${LLM_ENV_KEYS.modelBalanced}: ${
      process.env[LLM_ENV_KEYS.modelBalanced] || "(fallback)"
    }`
  );
  console.log(
    `    ${LLM_ENV_KEYS.baseUrlBalanced}: ${flag(
      process.env[LLM_ENV_KEYS.baseUrlBalanced]
    )}`
  );
  console.log("  Quality (Monthly/Yearly):");
  console.log(
    `    ${LLM_ENV_KEYS.modelQuality}: ${
      process.env[LLM_ENV_KEYS.modelQuality] || "(fallback)"
    }`
  );
  console.log(
    `    ${LLM_ENV_KEYS.baseUrlQuality}: ${flag(
      process.env[LLM_ENV_KEYS.baseUrlQuality]
    )}`
  );
  console.log("Config Files");
  console.log(`  envPath: ${config.paths.envPath || "(not found)"}`);
  console.log(`  configPath: ${config.paths.configPath}`);
  console.log(`  outputDir: ${config.paths.outputDir}`);
  console.log("======================================");
}

try {
  fs.mkdirSync(config.paths.outputDir, { recursive: true });
} catch (error) {
  logger.error("Failed to create outputDir", error instanceof Error ? error : undefined);
  logger.debug("outputDir", config.paths.outputDir);
}

const app = express();
const PORT = config.server.port;

// Middleware
app.use(cors());
app.use(requestIdMiddleware);
app.use(express.json({ limit: "50mb" }));

// Simple request logging (avoid spamming for SSE)
app.use((req, res, next) => {
  if (!req.originalUrl.includes("/api/summary/events")) {
    const requestId = res.locals.requestId as string | undefined;
    console.log(`[HTTP] ${req.method} ${req.originalUrl}${requestId ? ` (${requestId})` : ""}`);
  }
  next();
});

// Routes
app.use(API_MOUNTS.summary, summaryRouter);
app.use(API_MOUNTS.api, reposRouter);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// Error handler (must be last)
app.use(errorHandler);

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
