import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveStreamHealth,
  historyRetryDelay,
} from "../../../src/client/market/health.mjs";

test("history retry uses capped exponential steps with bounded jitter", () => {
  assert.equal(historyRetryDelay(1, () => 0.5), 2_000);
  assert.equal(historyRetryDelay(3, () => 0.5), 15_000);
  assert.equal(historyRetryDelay(99, () => 0.5), 60_000);
  assert.equal(historyRetryDelay(1, () => 0), 1_700);
  assert.equal(historyRetryDelay(1, () => 1), 2_300);
});

test("an active websocket with no recent trades is quiet instead of delayed", () => {
  assert.deepEqual(deriveStreamHealth({
    isOpen: true,
    lastTradeReceivedAt: 1_000,
    lastTransportActivityAt: 19_000,
    transportDelayMs: 100,
    now: 20_000,
  }), {
    badge: "QUIET",
    badgeClass: "quiet",
    detail: "最后 tick 19s前 · 连接有响应",
  });
});

test("stream health distinguishes delayed exchange data from a stale transport", () => {
  assert.equal(deriveStreamHealth({
    isOpen: true,
    lastTradeReceivedAt: 19_500,
    lastTransportActivityAt: 19_500,
    transportDelayMs: 8_000,
    now: 20_000,
  }).badge, "DELAYED");
  assert.equal(deriveStreamHealth({
    isOpen: true,
    lastTradeReceivedAt: 1_000,
    lastTransportActivityAt: 1_000,
    transportDelayMs: 100,
    now: 50_000,
  }).badge, "STALE");
});
