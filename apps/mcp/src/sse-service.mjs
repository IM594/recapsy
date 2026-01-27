import crypto from "node:crypto";

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function readJson(req, { maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error("Request body too large");
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        const error = new Error("Invalid JSON");
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function getTokenFromRequest(req, url) {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  const fromQuery = url.searchParams.get("token");
  if (fromQuery && fromQuery.trim() !== "") {
    return fromQuery.trim();
  }
  return null;
}

function tokenTailHint(value, { digits = 6 } = {}) {
  if (!value) return "(none)";
  const text = String(value);
  if (text.length <= digits) return "****";
  return `****${text.slice(-digits)}`;
}

function sendSseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
}

function writeSseEvent(res, { event, data }) {
  if (event) {
    res.write(`event: ${event}\n`);
  }
  const payload =
    typeof data === "string" ? data : JSON.stringify(data ?? null);
  for (const line of String(payload).split("\n")) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
}

function defaultGenerateSessionId() {
  return crypto.randomBytes(18).toString("base64url");
}

function defaultStartKeepAliveTimer({ res, keepAliveSeconds }) {
  const timer = setInterval(() => {
    try {
      res.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      // ignore
    }
  }, keepAliveSeconds * 1000);
  timer.unref();
  return timer;
}

export function createSseService({
  host = "127.0.0.1",
  token,
  keepAliveSeconds = 15,
  handleRequest,
  logger = console,
  generateSessionId = defaultGenerateSessionId,
  startKeepAliveTimer = defaultStartKeepAliveTimer,
  clearKeepAliveTimer = clearInterval,
  onShutdown,
} = {}) {
  if (!token) throw new Error("token is required");
  if (typeof handleRequest !== "function") throw new Error("handleRequest is required");

  const effectiveKeepAliveSeconds = parsePositiveInt(keepAliveSeconds, 15);

  // sessionId -> { res, keepAliveTimer, createdAt }
  const sessions = new Map();

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, service: "recapsense-mcp-sse", pid: process.pid });
      }

      if (req.method === "POST" && url.pathname === "/shutdown") {
        const provided = getTokenFromRequest(req, url);
        if (provided !== token) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }
        sendJson(res, 202, { ok: true });
        try {
          onShutdown?.();
        } catch {
          // ignore
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/sse") {
        const provided = getTokenFromRequest(req, url);
        if (provided !== token) {
          logger.warn(
            `[mcp-sse] unauthorized /sse request (provided=${tokenTailHint(provided)})`
          );
          return sendJson(res, 401, { error: "Unauthorized" });
        }

        const sessionId = generateSessionId();
        sendSseHeaders(res);
        writeSseEvent(res, { event: "endpoint", data: `/message?sessionId=${sessionId}` });

        const keepAliveTimer = startKeepAliveTimer({ res, keepAliveSeconds: effectiveKeepAliveSeconds });

        sessions.set(sessionId, {
          res,
          keepAliveTimer,
          createdAt: Date.now(),
        });

        req.on("close", () => {
          const session = sessions.get(sessionId);
          if (session) {
            try {
              clearKeepAliveTimer(session.keepAliveTimer);
            } catch {
              // ignore
            }
          }
          sessions.delete(sessionId);
        });

        return;
      }

      if (req.method === "POST" && url.pathname === "/message") {
        const sessionIdFromQuery = url.searchParams.get("sessionId")?.trim();
        let sessionId = sessionIdFromQuery;

        const provided = getTokenFromRequest(req, url);

        if (!sessionId && provided === token) {
          if (sessions.size === 1) sessionId = [...sessions.keys()][0];
        }

        const authorized =
          provided === token || (sessionId && sessions.has(sessionId));
        if (!authorized) {
          logger.warn(
            `[mcp-sse] unauthorized /message request (hasSessionId=${Boolean(
              sessionIdFromQuery
            )} provided=${tokenTailHint(provided)})`
          );
          return sendJson(res, 401, { error: "Unauthorized" });
        }

        if (!sessionId || !sessions.has(sessionId)) {
          logger.warn(
            `[mcp-sse] /message requested but session is missing (activeSessions=${sessions.size})`
          );
          return sendJson(res, 404, { error: "Unknown session" });
        }

        const session = sessions.get(sessionId);
        const message = await readJson(req);
        const response = await handleRequest(message);

        if (response && session?.res) {
          writeSseEvent(session.res, { event: "message", data: response });
        }

        return sendJson(res, 202, { ok: true });
      }

      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = Number(error?.statusCode ?? 500);
      const message = error instanceof Error ? error.message : String(error);
      return sendJson(res, statusCode, { error: message });
    }
  };

  return { handler, sessions };
}

