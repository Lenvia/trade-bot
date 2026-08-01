import test from "node:test";
import assert from "node:assert/strict";

import { applyTradeToBars, mergeHistoryWithLive } from "../live-data.mjs";

const FIVE_MINUTES = 5 * 60 * 1000;

test("a live trade updates the current 5-minute candle", () => {
  const start = Date.UTC(2026, 7, 1, 8, 0);
  const bars = [{ time: start, open: 100, high: 102, low: 99, close: 101, volume: 5 }];

  const result = applyTradeToBars(
    bars,
    { time: start + 2 * 60 * 1000, price: 103, size: 1.5 },
    FIVE_MINUTES,
  );

  assert.deepEqual(result, { updated: true, created: false });
  assert.deepEqual(bars[0], {
    time: start,
    open: 100,
    high: 103,
    low: 99,
    close: 103,
    volume: 6.5,
  });
});

test("a trade after the boundary creates the next 5-minute candle", () => {
  const start = Date.UTC(2026, 7, 1, 8, 0);
  const bars = [{ time: start, open: 100, high: 102, low: 99, close: 101, volume: 5 }];

  const result = applyTradeToBars(
    bars,
    { time: start + FIVE_MINUTES + 1000, price: 104, size: 0.25 },
    FIVE_MINUTES,
  );

  assert.deepEqual(result, { updated: true, created: true });
  assert.deepEqual(bars.at(-1), {
    time: start + FIVE_MINUTES,
    open: 104,
    high: 104,
    low: 104,
    close: 104,
    volume: 0.25,
  });
});

test("history reconciliation corrects closed bars and preserves the latest live close", () => {
  const start = Date.UTC(2026, 7, 1, 8, 0);
  const live = [
    { time: start, open: 100, high: 102, low: 99, close: 101, volume: 5 },
    { time: start + FIVE_MINUTES, open: 101, high: 105, low: 100, close: 104, volume: 3 },
  ];
  const history = [
    { time: start, open: 100, high: 103, low: 98, close: 102, volume: 8 },
    { time: start + FIVE_MINUTES, open: 102, high: 104, low: 101, close: 103, volume: 6 },
  ];

  const merged = mergeHistoryWithLive(history, live);

  assert.deepEqual(merged[0], history[0]);
  assert.deepEqual(merged[1], {
    time: start + FIVE_MINUTES,
    open: 102,
    high: 105,
    low: 100,
    close: 104,
    volume: 6,
  });
});
