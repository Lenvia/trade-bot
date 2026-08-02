import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const clientRoot = join(projectRoot, "src", "client");
const serverRoot = join(projectRoot, "src", "server");

test("browser modules never import server-only code", () => {
  for (const file of listModules(clientRoot)) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /(?:\/src\/server|\.\.\/server)/, file);
    assert.doesNotMatch(source, /node:(?:fs|http|net|child_process)/, file);
  }
});

test("provider adapters remain independent from charts, indicators, and DOM", () => {
  const sourcesRoot = join(clientRoot, "market", "sources");
  for (const file of listModules(sourcesRoot)) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /(?:charts|indicators|document\.|window\.)/, file);
  }
});

test("server modules never import browser implementation modules", () => {
  for (const file of listModules(serverRoot)) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /^import\s.+["'](?:\/src\/client|\.\.\/client)/m,
      file,
    );
  }
});

function listModules(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listModules(path) : entry.name.endsWith(".mjs") ? [path] : [];
  });
}
