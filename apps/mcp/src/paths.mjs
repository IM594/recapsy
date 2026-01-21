import path from "node:path";

export function resolveDataDir() {
  const configured = process.env.RECAPSENSE_DATA_DIR;
  if (configured && configured.trim() !== "") {
    return configured;
  }
  return path.join(process.cwd(), ".recapsense");
}

