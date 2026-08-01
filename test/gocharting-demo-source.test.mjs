import test from "node:test";
import assert from "node:assert/strict";

import {
  GoChartingDemoSource,
  normalizeBar,
  normalizeTrades,
} from "../data-sources/gocharting-demo.mjs";

const selection = {
  symbol: "BYBIT:FUTURE:BTCUSDT",
  interval: "5m",
  rows: 200,
};

test("GoCharting payloads are normalized behind the source boundary", () => {
  assert.deepEqual(normalizeBar({
    date: "2026-08-01T08:00:00Z",
    open: "100",
    high: "103",
    low: "99",
    close: "102",
    volume: "12.5",
  }), {
    time: Date.parse("2026-08-01T08:00:00Z"),
    open: 100,
    high: 103,
    low: 99,
    close: 102,
    volume: 12.5,
  });

  assert.deepEqual(normalizeTrades({
    [selection.symbol]: [{ trade_id: "abc", t_ms: 123, ltp: "101", l_sz: "0.5", side: "Buy" }],
  }, selection.symbol), [{ id: "abc", time: 123, price: 101, size: 0.5, side: "buy" }]);
});

test("a matching history error releases the request so reconciliation can resume", () => {
  const harness = createHarness();
  harness.source.connect(selection);
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  const firstRequest = harness.starts.at(-1);

  socket.message(JSON.stringify({
    command: "ERROR",
    request_id: firstRequest.requestId,
    message: "Rate limited",
  }));

  assert.equal(harness.errors.at(-1).reason, "provider");
  const next = harness.source.requestHistory({ background: true });
  assert.equal(next.background, true);
  assert.notEqual(next.requestId, firstRequest.requestId);
});

test("a timed-out history request is cleared instead of blocking future requests", () => {
  const harness = createHarness();
  harness.source.connect(selection);
  FakeWebSocket.instances.at(-1).open();

  harness.scheduler.runTimeouts(15_000);

  assert.equal(harness.errors.at(-1).reason, "timeout");
  assert.ok(harness.source.requestHistory({ background: true }));
});

test("a missing PONG closes a half-open socket and schedules reconnect", () => {
  let now = 0;
  const harness = createHarness(() => now);
  harness.source.connect(selection);
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();

  now = 46_000;
  harness.scheduler.runIntervals(20_000);

  assert.equal(socket.closeCode, 4000);
  assert.ok(harness.states.some(({ message }) => message.includes("秒后重连")));
});

function createHarness(now = () => 0) {
  FakeWebSocket.instances.length = 0;
  const scheduler = new FakeScheduler();
  const starts = [];
  const errors = [];
  const states = [];
  const source = new GoChartingDemoSource({
    WebSocketImpl: FakeWebSocket,
    scheduler,
    now,
    callbacks: {
      onHistoryStart: (request) => starts.push(request),
      onHistoryError: (error) => errors.push(error),
      onConnectionState: (state) => states.push(state),
    },
  });
  return { source, scheduler, starts, errors, states };
}

class FakeScheduler {
  constructor() {
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

  runTimeouts(delay) {
    for (const [id, timer] of [...this.timeouts]) {
      if (timer.delay !== delay) continue;
      this.timeouts.delete(id);
      timer.callback();
    }
  }

  runIntervals(delay) {
    for (const timer of this.intervals.values()) {
      if (timer.delay === delay) timer.callback();
    }
  }
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
    this.closeCode = null;
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
    this.closeCode = code;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code, reason });
  }
}
