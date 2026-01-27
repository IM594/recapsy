import http from "node:http";
import net from "node:net";

export async function canListenTcp({ host = "127.0.0.1" } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error && typeof error === "object" && error.code === "EPERM") {
        resolve(false);
        return;
      }
      // 其他错误（例如 EADDRNOTAVAIL）也视为不可用。
      resolve(false);
    });
    server.listen(0, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function getAvailablePort({ host = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close(() => {
        if (!port) return reject(new Error("failed to get ephemeral port"));
        resolve(port);
      });
    });
  });
}

export async function waitForHttpOk(url, { timeoutMs = 3000, intervalMs = 80 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${url}`);
}

export async function httpRequest({
  url,
  method = "GET",
  headers,
  body,
  timeoutMs = 3000,
} = {}) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url);
    const req = http.request(
      {
        method,
        hostname: requestUrl.hostname,
        port: requestUrl.port,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);

    if (body != null) req.write(body);
    req.end();
  });
}

