import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectNetworkRoute } from "./network-route.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const publicRoot = join(projectRoot, "public");
const clientRoot = join(projectRoot, "src", "client");
const port = Number.parseInt(
  process.env.MARKET_DATA_DEMO_PORT ?? process.env.GOCHARTING_DEMO_PORT ?? "8765",
  10,
);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/api/network-route") {
    void sendNetworkRoute(response);
    return;
  }

  const filePath = resolveStaticFile(url.pathname);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendNotFound(response);
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).pipe(response);
});

function resolveStaticFile(pathname) {
  if (pathname === "/") return join(publicRoot, "index.html");
  const clientPrefix = "/src/client/";
  if (pathname.startsWith(clientPrefix)) {
    if (extname(pathname) !== ".mjs") return null;
    return safeResolve(clientRoot, pathname.slice(clientPrefix.length));
  }
  return safeResolve(publicRoot, pathname.slice(1));
}

function safeResolve(root, requestPath) {
  const filePath = resolve(root, requestPath);
  const pathFromRoot = relative(root, filePath);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) return null;
  return filePath;
}

function sendNotFound(response) {
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

async function sendNetworkRoute(response) {
  const result = await detectNetworkRoute();
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(result));
}

server.listen(port, "127.0.0.1", () => {
  console.log(`Codex Data Lab: http://127.0.0.1:${port}`);
  console.log("Press Ctrl+C to stop.");
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
