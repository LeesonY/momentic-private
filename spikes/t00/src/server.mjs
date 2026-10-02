import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../fixture");

export function startServer() {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end("error");
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

async function handle(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("method");
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/api/ping") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, marker: "ping" }));
    return;
  }
  if (url.pathname === "/api/hang") return;

  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const file = path.resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(400, { "cache-control": "no-store" });
    res.end("bad path");
    return;
  }
  let body;
  try {
    body = await readFile(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("not found");
    return;
  }
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  };
  if (rel === "index.html") {
    headers["set-cookie"] = "lqa_session=LQA_COOKIE_SECRET; Path=/; HttpOnly; SameSite=Lax";
  }
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}
