import test from "node:test";
import assert from "node:assert/strict";

import { resolveIndicatorScale } from "../../../src/client/charts/indicator-renderer.mjs";

function definition(mode, scale = {}) {
  return {
    id: "sample",
    pane: {
      scale: { mode, ...scale },
      series: [{ key: "value", type: "line" }],
    },
  };
}

test("fixed indicator scale uses declared bounds", () => {
  assert.deepEqual(resolveIndicatorScale(definition("fixed", { min: 0, max: 100 }), { value: [30, 70] }), { min: 0, max: 100 });
});

test("symmetric indicator scale stays centered around zero", () => {
  const scale = resolveIndicatorScale(definition("symmetric"), { value: [-2, 4] });
  assert.equal(scale.min, -scale.max);
  assert.ok(scale.max > 4);
});

test("auto indicator scale adds breathing room", () => {
  const scale = resolveIndicatorScale(definition("auto"), { value: [10, 20] });
  assert.ok(scale.min < 10);
  assert.ok(scale.max > 20);
});
