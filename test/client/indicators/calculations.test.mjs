import test from "node:test";
import assert from "node:assert/strict";
import {
  ema,
  latestFinite,
  macd,
  rsi,
  splitThresholdSegments,
} from "../../../src/client/indicators/calculations.mjs";

test("EMA of a constant series stays constant after the seed", () => {
  const result = ema(Array(12).fill(42), 5);
  assert.deepEqual(result.slice(0, 4), [null, null, null, null]);
  assert.ok(result.slice(4).every((value) => value === 42));
});

test("RSI reaches 100 for a strictly increasing series", () => {
  const values = Array.from({ length: 30 }, (_, index) => index + 1);
  const result = rsi(values, 14);
  assert.equal(result[13], null);
  assert.equal(result[14], 100);
  assert.equal(latestFinite(result), 100);
});

test("RSI is 50 for a flat series", () => {
  const result = rsi(Array(30).fill(100), 14);
  assert.equal(latestFinite(result), 50);
});

test("MACD of a constant series converges to zero within float tolerance", () => {
  const result = macd(Array(80).fill(123.45));
  assert.ok(Math.abs(latestFinite(result.line)) < 1e-10);
  assert.ok(Math.abs(latestFinite(result.signal)) < 1e-10);
  assert.ok(Math.abs(latestFinite(result.histogram)) < 1e-10);
});

test("MACD validates fast and slow period order", () => {
  assert.throws(() => macd([1, 2, 3], 26, 12, 9), /fastPeriod/);
});

test("RSI line changes to overbought color exactly at the 70 crossing", () => {
  const segments = splitThresholdSegments([50, 80]);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].zone, "neutral");
  assert.equal(segments[0].to.value, 70);
  assert.ok(Math.abs(segments[0].to.index - (2 / 3)) < 1e-12);
  assert.equal(segments[1].zone, "overbought");
});

test("a falling RSI segment is split across overbought, neutral, and oversold zones", () => {
  const segments = splitThresholdSegments([80, 20]);
  assert.deepEqual(segments.map(({ zone }) => zone), ["overbought", "neutral", "oversold"]);
  assert.deepEqual(segments.map(({ to }) => to.value), [70, 30, 20]);
});

test("RSI threshold coloring does not bridge missing indicator values", () => {
  assert.deepEqual(splitThresholdSegments([80, null, 20]), []);
});
