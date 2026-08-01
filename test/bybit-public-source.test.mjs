import test from "node:test";
import assert from "node:assert/strict";

import {
  BybitPublicSource,
  bybitInterval,
  bybitSymbol,
  normalizeBybitBar,
  normalizeBybitTrades,
} from "../data-sources/bybit-public.mjs";

const selection = {
  symbol: "BYBIT:FUTURE:BNBUSDT",
  interval: "15m",
  rows: 200,
};

test("Bybit symbols, intervals, bars, and trades normalize behind the source boundary", () => {
  assert.equal(bybitSymbol(selection.symbol), "BNBUSDT");
  assert.equal(bybitInterval("15m"), "15");
  assert.deepEqual(normalizeBybitBar(["1000", "577", "580", "575", "579", "12.5"]), {
    time: 1000,
    open: 577,
    high: 580,
    low: 575,
    close: 579,
    volume: 12.5,
  });
  assert.deepEqual(normalizeBybitTrades([
    { i: "trade-1", T: 1234, p: "579.1", v: "0.5", S: "Buy" },
  ]), [{ id: "trade-1", time: 1234, price: 579.1, size: 0.5, side: "buy" }]);
});

test("opening the source subscribes to BNB trades and loads sorted history", async () => {
  const fetchCalls = [];
  const histories = [];
  const trades = [];
  const source = new BybitPublicSource({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return response({
        retCode: 0,
        retMsg: "OK",
        result: { list: [
          ["2000", "579", "582", "578", "581", "8"],
          ["1000", "577", "580", "575", "579", "12"],
        ] },
      });
    },
    callbacks: {
      onHistory: (history) => histories.push(history),
      onTrades: (incoming) => trades.push(...incoming),
    },
  });

  source.connect(selection);
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  await flushPromises();

  assert.match(fetchCalls[0], /symbol=BNBUSDT/);
  assert.match(fetchCalls[0], /interval=15/);
  assert.deepEqual(histories[0].bars.map(({ time }) => time), [1000, 2000]);
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    op: "subscribe",
    args: ["publicTrade.BNBUSDT"],
  });

  socket.message(JSON.stringify({
    topic: "publicTrade.BNBUSDT",
    data: [{ i: "live-1", T: 3000, p: "581.2", v: "0.2", S: "Sell" }],
  }));
  assert.equal(trades[0].price, 581.2);
  source.disconnect();
});

test("a provider error releases the history request for a later refresh", async () => {
  let shouldFail = true;
  const errors = [];
  const source = new BybitPublicSource({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async () => response(shouldFail
      ? { retCode: 10001, retMsg: "Bad request" }
      : { retCode: 0, retMsg: "OK", result: { list: [] } }),
    callbacks: { onHistoryError: (error) => errors.push(error) },
  });

  source.connect(selection);
  FakeWebSocket.instances.at(-1).open();
  await flushPromises();
  assert.equal(errors.at(-1).reason, "provider");

  shouldFail = false;
  assert.ok(source.requestHistory({ background: true }));
  await flushPromises();
  source.disconnect();
});

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) ?? [];
    callbacks.push(callback);
    this.listeners.set(name, callbacks);
  }

  dispatch(name, event = {}) {
    for (const callback of this.listeners.get(name) ?? []) callback(event);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open");
  }

  send(message) {
    this.sent.push(message);
  }

  message(data) {
    this.dispatch("message", { data });
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code, reason });
  }
}
