import test from "node:test";
import assert from "node:assert/strict";
import {
  getVisibleWindow,
  indexFromPlotX,
  minimumVisibleBarsForPlotWidth,
  panWindow,
  zoomWindow,
} from "../chart-view.mjs";

test("visible window follows the newest bars by default", () => {
  assert.deepEqual(getVisibleWindow(500, 120, 0), {
    start: 380,
    end: 500,
    count: 120,
    offset: 0,
  });
});

test("visible window clamps excessive pan offsets", () => {
  assert.deepEqual(getVisibleWindow(100, 40, 999), {
    start: 0,
    end: 40,
    count: 40,
    offset: 60,
  });
});

test("zoom keeps the approximate pointer anchor in view", () => {
  const result = zoomWindow(500, 120, 0, 0.5, 0.5);
  assert.equal(result.visibleCount, 60);
  const window = getVisibleWindow(500, result.visibleCount, result.rightOffset);
  assert.ok(window.start <= 439 && window.end >= 439);
});

test("desktop zoom stops before candle slots become sparse", () => {
  const minimum = minimumVisibleBarsForPlotWidth(1093);
  assert.equal(minimum, 85);

  const result = zoomWindow(500, 90, 0, 0.5, 0.5, minimum);
  assert.equal(result.visibleCount, 85);
  const cappedAgain = zoomWindow(500, result.visibleCount, result.rightOffset, 0.5, 0.5, minimum);
  assert.equal(cappedAgain.visibleCount, 85);
});

test("narrow plots retain the base mobile zoom range", () => {
  assert.equal(minimumVisibleBarsForPlotWidth(230), 20);
});

test("pan moves toward older bars and remains bounded", () => {
  assert.equal(panWindow(500, 100, 0, 25).rightOffset, 25);
  assert.equal(panWindow(500, 100, 0, -25).rightOffset, 0);
});

test("plot x coordinate maps to the expected absolute bar index", () => {
  const window = getVisibleWindow(500, 100, 20);
  assert.equal(indexFromPlotX(10, 10, 1000, window), 380);
  assert.equal(indexFromPlotX(1009, 10, 1000, window), 479);
});
