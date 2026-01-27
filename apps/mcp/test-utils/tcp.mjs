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

