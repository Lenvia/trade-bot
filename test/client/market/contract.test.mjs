import test from "node:test";
import assert from "node:assert/strict";

import {
  MARKET_DATA_CONTRACT_VERSION,
  assertMarketDataSource,
  createCanonicalBar,
  createCanonicalTrade,
  normalizeMarketSelection,
  parseProductId,
} from "../../../src/client/market/contract.mjs";

test("canonical product ids and selections are provider-independent", () => {
  assert.equal(MARKET_DATA_CONTRACT_VERSION, 1);
  assert.deepEqual(parseProductId("bybit:future:bnbusdt"), {
    productId: "BYBIT:FUTURE:BNBUSDT",
    venue: "BYBIT",
    marketType: "FUTURE",
    symbol: "BNBUSDT",
  });
  assert.deepEqual(normalizeMarketSelection({
    symbol: "bybit:future:bnbusdt",
    interval: "15m",
    rows: "200",
  }), {
    symbol: "BYBIT:FUTURE:BNBUSDT",
    interval: "15m",
    rows: 200,
  });
  assert.equal(normalizeMarketSelection({
    symbol: "BYBIT:FUTURE:BNBUSDT",
    interval: "4h",
    rows: 200,
  }).interval, "4h");
});

test("canonical bars enforce OHLCV invariants", () => {
  assert.deepEqual(createCanonicalBar({
    time: "1000", open: "10", high: "12", low: "9", close: "11", volume: "2",
  }), { time: 1000, open: 10, high: 12, low: 9, close: 11, volume: 2 });
  assert.equal(createCanonicalBar({
    time: 1000, open: 10, high: 9, low: 8, close: 11, volume: 2,
  }), null);
});

test("canonical trades normalize side and reject invalid size", () => {
  assert.deepEqual(createCanonicalTrade({
    id: 1, time: "1000", price: "11", size: "0.5", side: "BUY",
  }), { id: "1", time: 1000, price: 11, size: 0.5, side: "buy" });
  assert.equal(createCanonicalTrade({ time: 1000, price: 11, size: -1, side: "Sell" }), null);
});

test("the runtime source assertion protects the composition boundary", () => {
  const valid = {
    isOpen: false,
    connect() {},
    disconnect() {},
    reconnectNow() {},
    updateSelection() {},
    requestHistory() {},
  };
  assert.equal(assertMarketDataSource(valid), valid);
  assert.throws(() => assertMarketDataSource({ isOpen: false }), /missing method: connect/);
});
