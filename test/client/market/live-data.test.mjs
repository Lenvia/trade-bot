import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTradeToBars,
  createTradeDeduper,
  mergeHistoryWithLive,
  reconcileHistoryWithTrades,
  replayTradesOnBars,
} from "../../../src/client/market/live-data.mjs";

const FIVE_MINUTES = 5 * 60 * 1000;
const FOUR_HOURS = 4 * 60 * 60 * 1000;

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
    lastTradeTime: start + 2 * 60 * 1000,
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
    lastTradeTime: start + FIVE_MINUTES + 1000,
  });
});

test("4-hour trades remain in the same canonical bucket until the boundary", () => {
  const start = Date.UTC(2026, 7, 1, 8, 0);
  const bars = [{ time: start, open: 100, high: 100, low: 100, close: 100, volume: 1 }];

  const within = applyTradeToBars(bars, { time: start + FOUR_HOURS - 1, price: 103, size: 2 }, FOUR_HOURS);
  const next = applyTradeToBars(bars, { time: start + FOUR_HOURS, price: 104, size: 1 }, FOUR_HOURS);

  assert.deepEqual(within, { updated: true, created: false });
  assert.deepEqual(next, { updated: true, created: true });
  assert.equal(bars[0].close, 103);
  assert.equal(bars[1].time, start + FOUR_HOURS);
});

test("the first live trade can seed an empty series while history is loading", () => {
  const start = Date.UTC(2026, 7, 1, 8, 0);
  const bars = [];

  const result = applyTradeToBars(
    bars,
    { time: start + 30_000, price: 101, size: 0.5 },
    FIVE_MINUTES,
  );

  assert.deepEqual(result, { updated: true, created: true });
  assert.deepEqual(bars, [{
    time: start,
    open: 101,
    high: 101,
    low: 101,
    close: 101,
    volume: 0.5,
    lastTradeTime: start + 30_000,
  }]);
});

test("an out-of-order trade updates range and volume without moving close backward", () => {
  const start = Date.UTC(2026, 7, 1, 8, 0);
  const bars = [{ time: start, open: 100, high: 100, low: 100, close: 100, volume: 0 }];

  applyTradeToBars(bars, { time: start + 120_000, price: 102, size: 1 }, FIVE_MINUTES);
  applyTradeToBars(bars, { time: start + 60_000, price: 99, size: 2 }, FIVE_MINUTES);

  assert.equal(bars[0].close, 102);
  assert.equal(bars[0].low, 99);
  assert.equal(bars[0].volume, 3);
  assert.equal(bars[0].lastTradeTime, start + 120_000);
});

test("trade deduplication requires a provider-supplied stable id", () => {
  const deduper = createTradeDeduper(2);

  assert.equal(deduper.accepts({ id: "trade-1" }), true);
  assert.equal(deduper.accepts({ id: "trade-1" }), false);
  assert.equal(deduper.accepts({ id: null }), true);
  assert.equal(deduper.accepts({ id: null }), true);
  deduper.clear();
  assert.equal(deduper.accepts({ id: "trade-1" }), true);
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

test("a stale history snapshot does not move the latest live baseline backward", () => {
  const start = Date.UTC(2026, 7, 1, 8, 0);
  const baseline = [
    { time: start, open: 90, high: 95, low: 89, close: 94, volume: 10 },
    {
      time: start + FIVE_MINUTES,
      open: 100,
      high: 112,
      low: 99,
      close: 110,
      volume: 105,
      lastTradeTime: start + FIVE_MINUTES + 120_000,
    },
  ];
  const snapshot = [
    { time: start + FIVE_MINUTES, open: 100, high: 106, low: 100, close: 105, volume: 100 },
  ];

  const result = reconcileHistoryWithTrades(snapshot, baseline, [], FIVE_MINUTES);

  assert.deepEqual(result, baseline);
});

test("trades received during history loading are replayed onto the completed snapshot", () => {
  const start = Date.UTC(2026, 7, 1, 8, 0);
  const history = [
    { time: start, open: 100, high: 102, low: 99, close: 101, volume: 5 },
  ];
  const trades = [
    { time: start + 120_000, price: 104, size: 1 },
    { time: start + 60_000, price: 98, size: 2 },
  ];

  const result = reconcileHistoryWithTrades(history, [], trades, FIVE_MINUTES);

  assert.equal(result[0].high, 104);
  assert.equal(result[0].low, 98);
  assert.equal(result[0].close, 104);
  assert.equal(result[0].volume, 5);
  assert.equal(result[0].lastTradeTime, start + 120_000);
});

test("buffered trades are preserved in every bucket crossed during history loading", () => {
  const start = Date.UTC(2026, 7, 1, 8, 0);
  const ONE_MINUTE = 60_000;
  const history = [
    { time: start, open: 100, high: 100, low: 100, close: 100, volume: 10 },
    { time: start + ONE_MINUTE, open: 100, high: 100, low: 100, close: 100, volume: 10 },
  ];
  const trades = [
    { time: start + 59_000, price: 110, size: 1 },
    { time: start + 61_000, price: 120, size: 1 },
  ];

  const result = reconcileHistoryWithTrades(history, [], trades, ONE_MINUTE);

  assert.equal(result[0].high, 110);
  assert.equal(result[0].close, 110);
  assert.equal(result[1].high, 120);
  assert.equal(result[1].close, 120);
});

test("a failed foreground refresh can restore its baseline and buffered trades", () => {
  const start = Date.UTC(2026, 7, 1, 8, 0);
  const baseline = [
    { time: start, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  ];
  const trades = [{ time: start + 120_000, price: 105, size: 2 }];

  const restored = replayTradesOnBars(baseline, trades, FIVE_MINUTES);

  assert.equal(restored[0].high, 105);
  assert.equal(restored[0].close, 105);
  assert.equal(restored[0].volume, 12);
});
