import { Buffer } from "node:buffer";

export function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function readJson(req, { maxBytes = 1_000_000 } = {}) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return null;

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return null;

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Invalid JSON");
    error.statusCode = 400;
    throw error;
  }
}

export function requireAuth(req, token) {
  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${token}`;
  if (header !== expected) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

