import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const projectRoot = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", projectRoot), "utf8");
const app = readFileSync(new URL("app.mjs", projectRoot), "utf8");
const server = readFileSync(new URL("server.mjs", projectRoot), "utf8");

test("the initial chart interval is 15 minutes", () => {
  assert.match(html, /<option value="15m" selected>15 分钟<\/option>/);
  assert.doesNotMatch(html, /<option value="5m" selected>/);
});

test("the product title stays data-source neutral", () => {
  assert.match(html, /<title>Codex 数据实验室<\/title>/);
  assert.match(html, /<h1>Codex<br \/>数据实验室<\/h1>/);
  assert.doesNotMatch(html, /(?:Bybit|GoCharting) × Codex/);
});

test("the page bootstraps its first market-data connection automatically", () => {
  assert.match(app, /scheduleRender\(\);\s*connect\(\);\s*$/);
});

test("the initial market is BNBUSDT through the Bybit public source", () => {
  assert.match(html, /<option value="BYBIT:FUTURE:BNBUSDT" selected>BNBUSDT 永续<\/option>/);
  assert.match(app, /new BybitPublicSource\(/);
  assert.match(server, /"\/data-sources\/bybit-public\.mjs"/);
});
