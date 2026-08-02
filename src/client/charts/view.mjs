export const DEFAULT_VISIBLE_BARS = 120;
export const MIN_VISIBLE_BARS = 20;
export const MAX_ZOOM_SLOT_WIDTH = 13;

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function getVisibleWindow(totalBars, visibleCount, rightOffset) {
  const total = Math.max(0, Math.trunc(totalBars));
  if (total === 0) return { start: 0, end: 0, count: 0, offset: 0 };

  const count = clamp(Math.trunc(visibleCount), 1, total);
  const offset = clamp(Math.round(rightOffset), 0, Math.max(0, total - count));
  const end = total - offset;
  const start = Math.max(0, end - count);
  return { start, end, count: end - start, offset };
}

export function minimumVisibleBarsForPlotWidth(
  plotWidth,
  maximumSlotWidth = MAX_ZOOM_SLOT_WIDTH,
) {
  if (!Number.isFinite(plotWidth) || plotWidth <= 0) return MIN_VISIBLE_BARS;
  if (!Number.isFinite(maximumSlotWidth) || maximumSlotWidth <= 0) return MIN_VISIBLE_BARS;
  return Math.max(MIN_VISIBLE_BARS, Math.ceil(plotWidth / maximumSlotWidth));
}

export function zoomWindow(
  totalBars,
  visibleCount,
  rightOffset,
  pointerRatio,
  scale,
  minimumVisibleBars = MIN_VISIBLE_BARS,
) {
  const current = getVisibleWindow(totalBars, visibleCount, rightOffset);
  if (current.count === 0) return { visibleCount: visibleCount, rightOffset: 0 };

  const minimum = Math.min(
    Math.max(1, Math.trunc(minimumVisibleBars)),
    totalBars,
  );
  const nextCount = clamp(Math.round(current.count * scale), minimum, totalBars);
  const ratio = clamp(pointerRatio, 0, 1);
  const anchorIndex = current.start + ratio * Math.max(0, current.count - 1);
  const maximumStart = Math.max(0, totalBars - nextCount);
  const nextStart = clamp(
    Math.round(anchorIndex - ratio * Math.max(0, nextCount - 1)),
    0,
    maximumStart,
  );

  return {
    visibleCount: nextCount,
    rightOffset: totalBars - (nextStart + nextCount),
  };
}

export function panWindow(totalBars, visibleCount, rightOffset, deltaBars) {
  const current = getVisibleWindow(totalBars, visibleCount, rightOffset);
  return {
    visibleCount: current.count || visibleCount,
    rightOffset: clamp(
      Math.round(current.offset + deltaBars),
      0,
      Math.max(0, totalBars - current.count),
    ),
  };
}

export function indexFromPlotX(x, plotLeft, plotWidth, window) {
  if (window.count === 0 || plotWidth <= 0) return null;
  const localX = clamp(x - plotLeft, 0, Math.max(0, plotWidth - Number.EPSILON));
  const slot = plotWidth / window.count;
  const localIndex = clamp(Math.floor(localX / slot), 0, window.count - 1);
  return window.start + localIndex;
}
