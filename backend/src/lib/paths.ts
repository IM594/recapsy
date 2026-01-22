import path from "path";

export function getBaseOutputDir(): string {
  const configured = process.env.RECAPLY_OUTPUT_DIR;
  if (typeof configured === "string" && configured.trim()) {
    return path.resolve(configured);
  }
  return path.resolve(process.cwd(), "outputs");
}

export function getWorkflowDebugLogPath(): string {
  return path.join(getBaseOutputDir(), "workflow-debug.log");
}

