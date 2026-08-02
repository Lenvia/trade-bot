import test from "node:test";
import assert from "node:assert/strict";

import { calculateIndicatorSet, EMPTY_INDICATOR_SET } from "../../../src/client/indicators/builtins.mjs";

test("the dashboard indicator set is calculated once from normalized bars", () => {
  const bars = Array.from({ length: 80 }, (_, index) => ({ close: 100 + index }));
  const result = calculateIndicatorSet(bars);

  assert.equal(result.get("rsi14").data.value.length, bars.length);
  assert.equal(result.get("macd12_26_9").data.line.length, bars.length);
  assert.equal(result.get("macd12_26_9").data.signal.length, bars.length);
  assert.equal(result.get("macd12_26_9").data.histogram.length, bars.length);
  assert.equal(result.get("rsi14").error, null);
});

test("only active indicators are calculated", () => {
  const bars = Array.from({ length: 80 }, (_, index) => ({ close: 100 + index }));
  const result = calculateIndicatorSet(bars, ["rsi14"]);

  assert.deepEqual([...result.keys()], ["rsi14"]);
});

test("an empty bar series reuses the immutable empty indicator set", () => {
  assert.equal(calculateIndicatorSet([]), EMPTY_INDICATOR_SET);
});

test("invalid normalized closes are rejected at the derived-data boundary", () => {
  assert.throws(() => calculateIndicatorSet([{ close: Number.NaN }]), /finite close/);
});
