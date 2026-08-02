import { clamp } from "./view.mjs";
import {
  drawAxisLabel,
  drawSeries,
  drawTimeLabel,
  prepareCanvas,
} from "./price-renderer.mjs";
import { formatCrosshairTime, formatIndicator } from "../formatters.mjs";
import { splitThresholdSegments } from "../indicators/calculations.mjs";

export const INDICATOR_PADDING = Object.freeze({ left: 12, right: 78, top: 18, bottom: 24 });

export function drawIndicatorPane({
  canvas,
  allBars,
  entry,
  visibleWindow,
  hover,
  interval,
}) {
  const { context, width, height } = prepareCanvas(canvas);
  context.clearRect(0, 0, width, height);
  if (!entry) return;
  if (entry.error) {
    drawPaneMessage(context, width, height, `指标计算失败：${entry.error.message}`);
    return;
  }
  if (allBars.length === 0) return;

  const { definition, data } = entry;
  const padding = INDICATOR_PADDING;
  const plotWidth = width - padding.left - padding.right;
  const plotBottom = height - padding.bottom;
  const plotHeight = plotBottom - padding.top;
  const bars = allBars.slice(visibleWindow.start, visibleWindow.end);
  const seriesData = Object.fromEntries(definition.pane.series.map(({ key }) => [
    key,
    data[key].slice(visibleWindow.start, visibleWindow.end),
  ]));
  const { min, max } = resolveIndicatorScale(definition, seriesData);
  const range = max - min || 1;
  const y = (value) => plotBottom - ((value - min) / range) * plotHeight;
  const slot = plotWidth / Math.max(1, bars.length);
  const x = (index) => padding.left + slot * index + slot / 2;

  drawBands(context, definition.pane.bands, y, padding, plotWidth);
  drawLevels(context, definition.pane.levels, y, width, padding);
  for (const series of definition.pane.series) {
    drawConfiguredSeries(context, series, seriesData[series.key], x, y, slot, min, max);
  }

  context.fillStyle = "#8d99a6";
  context.font = "10px ui-monospace, monospace";
  context.textAlign = "right";
  context.fillText(formatIndicator(max), width - padding.right + 70, padding.top + 4);
  context.fillText(formatIndicator(min), width - padding.right + 70, plotBottom);
  context.textAlign = "left";

  const markerSeries = definition.pane.series.find(({ marker }) => marker);
  if (markerSeries) {
    const latest = [...seriesData[markerSeries.key]].reverse().find(Number.isFinite);
    if (Number.isFinite(latest)) {
      drawLatestMarker(context, latest, y(latest), markerSeries, width, padding);
    }
  }

  drawPaneCrosshair(context, {
    bars,
    data: seriesData,
    definition,
    window: visibleWindow,
    hover,
    interval,
    width,
    height,
    padding,
    slot,
  });
}

export function resolveIndicatorScale(definition, seriesData) {
  const scale = definition.pane.scale;
  if (scale.mode === "fixed") {
    const min = Number(scale.min);
    const max = Number(scale.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
      throw new RangeError(`Indicator ${definition.id} has an invalid fixed scale`);
    }
    return { min, max };
  }

  const finite = definition.pane.series
    .flatMap(({ key }) => seriesData[key] ?? [])
    .filter(Number.isFinite);
  if (finite.length === 0) return { min: -1, max: 1 };
  if (scale.mode === "symmetric") {
    const maxAbs = Math.max(...finite.map(Math.abs), 1e-9) * 1.12;
    return { min: -maxAbs, max: maxAbs };
  }
  const rawMin = Math.min(...finite);
  const rawMax = Math.max(...finite);
  const margin = Math.max((rawMax - rawMin) * 0.08, Math.abs(rawMax || 1) * 0.002);
  return { min: rawMin - margin, max: rawMax + margin };
}

function drawBands(context, bands, y, padding, plotWidth) {
  for (const band of bands) {
    const top = Math.min(y(band.from), y(band.to));
    const bottom = Math.max(y(band.from), y(band.to));
    context.fillStyle = band.color;
    context.fillRect(padding.left, top, plotWidth, bottom - top);
  }
}

function drawLevels(context, levels, y, width, padding) {
  context.save();
  context.font = "10px ui-monospace, monospace";
  for (const level of levels) {
    const lineY = y(level.value);
    context.strokeStyle = level.color ?? "rgba(141,153,166,0.3)";
    context.setLineDash(level.dash ?? []);
    context.beginPath();
    context.moveTo(padding.left, lineY);
    context.lineTo(width - padding.right, lineY);
    context.stroke();
    if (level.label) {
      context.fillStyle = level.color ?? "#8d99a6";
      context.textAlign = "right";
      context.fillText(level.label, width - padding.right - 7, lineY + 3);
    }
  }
  context.restore();
}

function drawConfiguredSeries(context, series, values, x, y, slot, min, max) {
  if (series.type === "histogram") {
    const baselineValue = clamp(0, min, max);
    const baseline = y(baselineValue);
    const width = clamp(slot * 0.56, 2, 7);
    values.forEach((value, index) => {
      if (!Number.isFinite(value)) return;
      const valueY = y(value);
      context.fillStyle = value >= baselineValue
        ? series.positiveColor ?? "rgba(98,230,167,0.55)"
        : series.negativeColor ?? "rgba(255,94,115,0.55)";
      context.fillRect(x(index) - width / 2, Math.min(baseline, valueY), width, Math.max(1, Math.abs(valueY - baseline)));
    });
    return;
  }
  if (series.type === "threshold-line") {
    const colors = series.colors ?? {};
    context.save();
    context.lineWidth = series.lineWidth ?? 2;
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const segment of splitThresholdSegments(values, series.lower, series.upper)) {
      context.strokeStyle = segment.zone === "overbought"
        ? colors.upper
        : segment.zone === "oversold"
          ? colors.lower
          : colors.middle;
      context.beginPath();
      context.moveTo(x(segment.from.index), y(segment.from.value));
      context.lineTo(x(segment.to.index), y(segment.to.value));
      context.stroke();
    }
    context.restore();
    return;
  }
  drawSeries(context, values, x, y, series.color ?? "#c7ff3d", series.lineWidth ?? 1.5);
}

function drawLatestMarker(context, value, markerY, series, width, padding) {
  const colors = series.colors ?? {};
  const color = series.type === "threshold-line"
    ? value >= series.upper
      ? colors.upper
      : value <= series.lower
        ? colors.lower
        : colors.middle
    : series.color ?? "#c7ff3d";
  drawAxisLabel(context, formatIndicator(value), width - padding.right + 3, markerY, color, width);
}

function drawPaneCrosshair(context, geometry) {
  const { hover } = geometry;
  if (!hover || hover.absoluteIndex < geometry.window.start || hover.absoluteIndex >= geometry.window.end) return;
  const localIndex = hover.absoluteIndex - geometry.window.start;
  const x = geometry.padding.left + geometry.slot * localIndex + geometry.slot / 2;
  context.save();
  context.strokeStyle = "rgba(205,218,228,0.68)";
  context.setLineDash([5, 5]);
  context.beginPath();
  context.moveTo(x, geometry.padding.top);
  context.lineTo(x, geometry.height - geometry.padding.bottom);
  context.stroke();
  context.restore();

  const text = geometry.definition.pane.readouts.map(({ key, label }) => (
    `${label} ${formatIndicator(geometry.data[key][localIndex])}`
  )).join("   ");
  if (text) {
    context.save();
    context.font = "10px ui-monospace, monospace";
    const tooltipWidth = Math.min(geometry.width - 16, context.measureText(text).width + 16);
    context.fillStyle = "rgba(9,11,14,0.88)";
    context.strokeStyle = "rgba(83,216,251,0.3)";
    context.fillRect(geometry.padding.left, 4, tooltipWidth, 24);
    context.strokeRect(geometry.padding.left, 4, tooltipWidth, 24);
    context.fillStyle = "#d7e2ea";
    context.fillText(text, geometry.padding.left + 8, 20);
    context.restore();
  }
  drawTimeLabel(
    context,
    formatCrosshairTime(geometry.bars[localIndex].time, geometry.interval),
    x,
    geometry.height - 19,
    geometry.width,
  );
}

function drawPaneMessage(context, width, height, message) {
  context.fillStyle = "#ff5e73";
  context.font = "12px ui-monospace, monospace";
  context.textAlign = "center";
  context.fillText(message, width / 2, height / 2);
  context.textAlign = "left";
}
