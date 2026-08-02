import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const projectRoot = new URL("../../", import.meta.url);
const html = readFileSync(new URL("public/index.html", projectRoot), "utf8");
const app = readFileSync(new URL("src/client/app.mjs", projectRoot), "utf8");
const server = readFileSync(new URL("src/server/server.mjs", projectRoot), "utf8");
const chartRenderer = readFileSync(new URL("src/client/charts/price-renderer.mjs", projectRoot), "utf8");

test("the initial chart interval is 15 minutes", () => {
  assert.match(html, /data-interval="15m" aria-pressed="true"/);
  assert.match(app, /interval: "15m"/);
});

test("frequent timeframes are fixed and the rest stay in one dropdown", () => {
  for (const interval of ["15m", "1h", "4h", "1D"]) {
    assert.match(html, new RegExp(`data-interval="${interval}"`));
  }
  assert.match(html, /<select id="intervalMenu"/);
  assert.match(html, /<option value="5m">5 分钟<\/option>/);
  assert.match(app, /function setTimeframe\(interval\)/);
});

test("the product title stays data-source neutral", () => {
  assert.match(html, /<title>Codex 数据实验室<\/title>/);
  assert.match(html, /<h1>Codex 数据实验室<\/h1>/);
  assert.doesNotMatch(html, /(?:Bybit|GoCharting) × Codex/);
});

test("the page bootstraps its first market-data connection automatically", () => {
  assert.match(app, /function initialize\(\)[\s\S]*connect\(\);/);
  assert.match(app, /initialize\(\);\s*$/);
});

test("the initial market is BNBUSDT through the Bybit public source", () => {
  assert.match(html, /data-symbol="BYBIT:FUTURE:BNBUSDT" aria-selected="true"/);
  assert.match(app, /symbol: "BYBIT:FUTURE:BNBUSDT"/);
  assert.match(app, /new BybitPublicSource\(/);
  assert.match(app, /market\/sources\/bybit-public\.mjs/);
});

test("indicators and panes use the registry extension boundary", () => {
  assert.match(html, /id="indicatorOptions"/);
  assert.match(html, /id="indicatorPanes"/);
  assert.doesNotMatch(html, /id="indicatorCanvas"/);
  assert.match(app, /INDICATOR_REGISTRY\.list\(\)/);
  assert.match(app, /drawIndicatorPane\(/);
  assert.match(app, /indicators\/builtins\.mjs/);
  assert.match(app, /charts\/indicator-renderer\.mjs/);
});

test("the fixed watchlist exposes the supported markets without favorites state", () => {
  for (const symbol of ["BNBUSDT", "BTCUSDT", "ETHUSDT"]) assert.match(html, new RegExp(symbol));
  assert.doesNotMatch(app, /localStorage|favorite/i);
});

test("canvas drawing uses the same real CSS width as pointer interactions", () => {
  assert.match(chartRenderer, /Math\.max\(1, canvas\.clientWidth\)/);
  assert.doesNotMatch(chartRenderer, /Math\.max\(300, canvas\.clientWidth\)/);
});

test("the dashboard exposes a truthful system proxy diagnostic", () => {
  assert.match(html, /id="routeBadge"/);
  assert.match(html, /id="routeText"/);
  assert.match(app, /fetch\("\/api\/network-route"/);
  assert.match(server, /detectNetworkRoute/);
  assert.match(server, /url\.pathname === "\/api\/network-route"/);
});

test("websocket, REST history, and network route have separate diagnostics", () => {
  assert.match(html, /id="diagnosticWs"/);
  assert.match(html, /id="diagnosticHistory"/);
  assert.match(html, /id="diagnosticRoute"/);
  assert.match(app, /deriveStreamHealth/);
  assert.match(app, /handleHistoryRetry/);
});

test("the static server exposes only public assets and browser client modules", () => {
  assert.match(server, /const publicRoot = join\(projectRoot, "public"\)/);
  assert.match(server, /const clientRoot = join\(projectRoot, "src", "client"\)/);
  assert.match(server, /function safeResolve\(root, requestPath\)/);
  assert.doesNotMatch(server, /publicFiles/);
});
