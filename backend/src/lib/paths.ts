import path from "path";
import { getConfig } from "../config";

export function getBaseOutputDir(): string {
  return getConfig().paths.outputDir;
}

export function getWorkflowDebugLogPath(): string {
  return path.join(getBaseOutputDir(), "workflow-debug.log");
}
