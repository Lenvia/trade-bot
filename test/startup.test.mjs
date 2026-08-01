import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const projectRoot = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", projectRoot), "utf8");
const app = readFileSync(new URL("app.mjs", projectRoot), "utf8");

test("the initial chart interval is 15 minutes", () => {
  assert.match(html, /<option value="15m" selected>15 分钟<\/option>/);
  assert.doesNotMatch(html, /<option value="5m" selected>/);
});

test("the page bootstraps its first market-data connection automatically", () => {
  assert.match(app, /scheduleRender\(\);\s*connect\(\);\s*$/);
});
