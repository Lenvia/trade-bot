import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateRegisteredIndicators,
  createIndicatorRegistry,
} from "../../../src/client/indicators/registry.mjs";

function definition(id, compute = (bars) => ({ value: bars.map(({ close }) => close) })) {
  return {
    id,
    label: id,
    compute,
    pane: {
      scale: { mode: "auto" },
      series: [{ key: "value", type: "line", color: "#fff" }],
      readouts: [{ key: "value", label: "Value" }],
    },
  };
}

test("registry rejects duplicate ids", () => {
  const registry = createIndicatorRegistry([definition("custom")]);
  assert.throws(() => registry.register(definition("custom")), /Duplicate indicator id/);
});

test("registry rejects pane settings that could break the generic renderer", () => {
  const invalidScale = definition("scale");
  invalidScale.pane.scale = { mode: "fixed", min: 10, max: 0 };
  assert.throws(() => createIndicatorRegistry([invalidScale]), /invalid fixed scale/);

  const invalidThreshold = definition("threshold");
  invalidThreshold.pane.series = [{ key: "value", type: "threshold-line", lower: 70, upper: 30 }];
  assert.throws(() => createIndicatorRegistry([invalidThreshold]), /invalid thresholds/);

  const invalidBand = definition("band");
  invalidBand.pane.bands = [{ from: 0, to: Number.NaN }];
  assert.throws(() => createIndicatorRegistry([invalidBand]), /invalid band/);
});

test("disabled indicators are not computed", () => {
  let calls = 0;
  const registry = createIndicatorRegistry([
    definition("active"),
    definition("disabled", (bars) => { calls += 1; return { value: bars.map(() => 1) }; }),
  ]);
  const result = calculateRegisteredIndicators([{ close: 2 }], ["active"], registry);

  assert.deepEqual([...result.keys()], ["active"]);
  assert.equal(calls, 0);
});

test("unknown and duplicate active ids fail explicitly", () => {
  const registry = createIndicatorRegistry([definition("known")]);
  assert.throws(() => calculateRegisteredIndicators([], ["missing"], registry), /Unknown indicator id/);
  assert.throws(() => calculateRegisteredIndicators([], ["known", "known"], registry), /Duplicate active indicator id/);
});

test("one invalid indicator result is isolated from healthy panes", () => {
  const registry = createIndicatorRegistry([
    definition("healthy"),
    definition("broken", () => ({ value: [Number.NaN] })),
  ]);
  const result = calculateRegisteredIndicators([{ close: 2 }], ["healthy", "broken"], registry);

  assert.equal(result.get("healthy").error, null);
  assert.match(result.get("broken").error.message, /finite values or null/);
});

test("a custom definition can register and compute without app changes", () => {
  const custom = definition("spread", (bars) => ({ value: bars.map((bar) => bar.high - bar.low) }));
  const registry = createIndicatorRegistry();
  registry.register(custom);
  const result = calculateRegisteredIndicators([{ close: 2, high: 5, low: 1 }], ["spread"], registry);

  assert.deepEqual(result.get("spread").data.value, [4]);
  assert.equal(registry.list()[0].pane.height, 240);
});
