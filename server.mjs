import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number.parseInt(process.env.GOCHARTING_DEMO_PORT ?? "8765", 10);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const publicFiles = new Set([
  "/",
  "/index.html",
  "/styles.css",
  "/app.mjs",
  "/indicators.mjs",
  "/indicator-set.mjs",
  "/formatters.mjs",
  "/chart-renderer.mjs",
  "/chart-view.mjs",
  "/live-data.mjs",
  "/data-sources/gocharting-demo.mjs",
]);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

  if (!publicFiles.has(url.pathname) && !publicFiles.has(pathname)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const filePath = join(root, pathname.slice(1));
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`GoCharting Codex Demo: http://127.0.0.1:${port}`);
  console.log("Press Ctrl+C to stop.");
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
