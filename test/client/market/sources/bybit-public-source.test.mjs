import test from "node:test";
import assert from "node:assert/strict";

import {
  BybitPublicSource,
  bybitInterval,
  bybitSymbol,
  normalizeBybitBar,
  normalizeBybitTrades,
} from "../../../../src/client/market/sources/bybit-public.mjs";

const selection = {
  symbol: "BYBIT:FUTURE:BNBUSDT",
  interval: "15m",
  rows: 200,
};

test("Bybit symbols, intervals, bars, and trades normalize behind the source boundary", () => {
  assert.equal(bybitSymbol(selection.symbol), "BNBUSDT");
  assert.equal(bybitInterval("15m"), "15");
  assert.equal(bybitInterval("4h"), "240");
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

test("failed initial history retries with backoff without reconnecting the websocket", async () => {
  const scheduler = new FakeScheduler();
  const retries = [];
  const histories = [];
  let fetchCount = 0;
  const source = new BybitPublicSource({
    WebSocketImpl: FakeWebSocket,
    scheduler,
    now: () => scheduler.now,
    random: () => 0.5,
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount === 1) throw new TypeError("Failed to fetch");
      return response({ retCode: 0, retMsg: "OK", result: { list: [] } });
    },
    callbacks: {
      onHistoryRetry: (retry) => retries.push(retry),
      onHistory: (history) => histories.push(history),
    },
  });

  source.connect(selection);
  FakeWebSocket.instances.at(-1).open();
  await flushPromises();

  assert.equal(retries.length, 1);
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[0].delay, 2_000);
  assert.equal(FakeWebSocket.instances.length > 0, true);

  scheduler.runNextTimeout();
  await flushPromises();
  assert.equal(fetchCount, 2);
  assert.equal(histories.length, 1);
  source.disconnect();
});

test("transport activity reports pong frames even when no trade arrives", async () => {
  const activity = [];
  const source = new BybitPublicSource({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async () => response({ retCode: 0, retMsg: "OK", result: { list: [] } }),
    callbacks: { onTransportActivity: (event) => activity.push(event.kind) },
  });

  source.connect(selection);
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  await flushPromises();
  socket.message(JSON.stringify({ op: "pong" }));
  assert.deepEqual(activity, ["open", "pong"]);
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

class FakeScheduler {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timeouts = new Map();
    this.intervals = new Map();
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.timeouts.set(id, { callback, delay });
    return id;
  }

  clearTimeout(id) {
    this.timeouts.delete(id);
  }

  setInterval(callback, delay) {
    const id = this.nextId++;
    this.intervals.set(id, { callback, delay });
    return id;
  }

  clearInterval(id) {
    this.intervals.delete(id);
  }

  runNextTimeout() {
    const [id, task] = [...this.timeouts.entries()].sort((left, right) => left[1].delay - right[1].delay)[0];
    this.timeouts.delete(id);
    this.now += task.delay;
    task.callback();
  }
}
