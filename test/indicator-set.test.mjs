import test from "node:test";
import assert from "node:assert/strict";

import { calculateIndicatorSet, EMPTY_INDICATOR_SET } from "../indicator-set.mjs";

test("the dashboard indicator set is calculated once from normalized bars", () => {
  const bars = Array.from({ length: 80 }, (_, index) => ({ close: 100 + index }));
  const result = calculateIndicatorSet(bars);

  assert.equal(result.rsi14.length, bars.length);
  assert.equal(result.macd12_26_9.line.length, bars.length);
  assert.equal(result.macd12_26_9.signal.length, bars.length);
  assert.equal(result.macd12_26_9.histogram.length, bars.length);
});

test("an empty bar series reuses the immutable empty indicator set", () => {
  assert.equal(calculateIndicatorSet([]), EMPTY_INDICATOR_SET);
});

test("invalid normalized closes are rejected at the derived-data boundary", () => {
  assert.throws(() => calculateIndicatorSet([{ close: Number.NaN }]), /finite close/);
});
