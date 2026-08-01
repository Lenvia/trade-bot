import { clamp } from "./chart-view.mjs";
import { splitThresholdSegments } from "./indicators.mjs";
import {
  compactNumber,
  formatCrosshairTime,
  formatIndicator,
  formatPrice,
} from "./formatters.mjs";

export const PRICE_PADDING = Object.freeze({ top: 24, right: 78, bottom: 34, left: 12 });
export const INDICATOR_PADDING = Object.freeze({ left: 12, right: 78, top: 8, bottom: 22 });

export function drawPriceChart({
  canvas,
  allBars,
  visibleWindow,
  hover,
  rightOffset,
  interval,
}) {
  const bars = allBars.slice(visibleWindow.start, visibleWindow.end);
  const { context, width, height } = prepareCanvas(canvas);
  context.clearRect(0, 0, width, height);
  if (bars.length === 0) return;

  const padding = PRICE_PADDING;
  const volumeHeight = height * 0.2;
  const priceBottom = height - padding.bottom - volumeHeight - 18;
  const prices = bars.flatMap(({ high, low }) => [high, low]);
  const rawMinPrice = Math.min(...prices);
  const rawMaxPrice = Math.max(...prices);
  const margin = Math.max((rawMaxPrice - rawMinPrice) * 0.06, rawMaxPrice * 0.0002);
  const minPrice = rawMinPrice - margin;
  const maxPrice = rawMaxPrice + margin;
  const priceRange = maxPrice - minPrice || 1;
  const volumeMax = Math.max(...bars.map(({ volume }) => volume), 1);
  const plotWidth = width - padding.left - padding.right;
  const slot = plotWidth / bars.length;
  const candleWidth = Math.max(1.5, Math.min(10, slot * 0.78));
  const yPrice = (value) => padding.top
    + ((maxPrice - value) / priceRange) * (priceBottom - padding.top);

  drawGrid(context, width, priceBottom, padding, minPrice, maxPrice, yPrice);
  bars.forEach((bar, index) => {
    const x = padding.left + slot * index + slot / 2;
    const rising = bar.close >= bar.open;
    const color = rising ? "#62e6a7" : "#ff5e73";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, yPrice(bar.high));
    context.lineTo(x, yPrice(bar.low));
    context.stroke();

    const bodyTop = yPrice(Math.max(bar.open, bar.close));
    const bodyHeight = Math.max(1, Math.abs(yPrice(bar.open) - yPrice(bar.close)));
    context.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);

    const volumeTop = height - padding.bottom - (bar.volume / volumeMax) * volumeHeight;
    context.globalAlpha = 0.38;
    context.fillRect(
      x - candleWidth / 2,
      volumeTop,
      candleWidth,
      height - padding.bottom - volumeTop,
    );
    context.globalAlpha = 1;
  });

  context.fillStyle = "rgba(141,153,166,0.72)";
  context.font = "9px ui-monospace, monospace";
  context.fillText("VOLUME", padding.left + 4, height - padding.bottom - volumeHeight + 12);

  drawLastPriceLine(context, {
    width,
    padding,
    minPrice,
    maxPrice,
    yPrice,
    rightOffset,
    lastBar: allBars.at(-1),
  });
  drawPriceCrosshair(context, {
    bars,
    window: visibleWindow,
    hover,
    interval,
    width,
    height,
    padding,
    priceBottom,
    slot,
    minPrice,
    maxPrice,
    yPrice,
  });

  context.fillStyle = "#8d99a6";
  context.font = "11px ui-monospace, monospace";
  context.fillText(new Date(bars[0].time).toLocaleDateString("zh-CN"), padding.left, height - 8);
  const lastLabel = formatCrosshairTime(bars.at(-1).time, interval);
  const labelWidth = context.measureText(lastLabel).width;
  context.fillText(lastLabel, width - padding.right - labelWidth, height - 8);
}

export function drawIndicatorChart({
  canvas,
  allBars,
  indicators,
  visibleWindow,
  hover,
  interval,
}) {
  const { context, width, height } = prepareCanvas(canvas);
  context.clearRect(0, 0, width, height);
  if (allBars.length === 0) return;

  const bars = allBars.slice(visibleWindow.start, visibleWindow.end);
  const rsiValues = indicators.rsi14.slice(visibleWindow.start, visibleWindow.end);
  const line = indicators.macd12_26_9.line.slice(visibleWindow.start, visibleWindow.end);
  const signal = indicators.macd12_26_9.signal.slice(visibleWindow.start, visibleWindow.end);
  const histogram = indicators.macd12_26_9.histogram.slice(visibleWindow.start, visibleWindow.end);
  const padding = INDICATOR_PADDING;
  const plotWidth = width - padding.left - padding.right;
  const slot = plotWidth / Math.max(1, bars.length);
  const x = (index) => padding.left + slot * index + slot / 2;

  const macdTop = padding.top + 17;
  const macdBottom = Math.round(height * 0.43);
  const rsiTop = macdBottom + 24;
  const rsiBottom = height - padding.bottom;
  const macdFinite = [...line, ...signal, ...histogram].filter(Number.isFinite);
  const maxAbs = Math.max(...macdFinite.map(Math.abs), 1e-9);
  const macdCenter = (macdTop + macdBottom) / 2;
  const macdAmplitude = (macdBottom - macdTop) * 0.44;
  const macdY = (value) => macdCenter - (value / maxAbs) * macdAmplitude;

  context.fillStyle = "rgba(83,216,251,0.025)";
  context.fillRect(padding.left, macdTop, plotWidth, macdBottom - macdTop);
  context.strokeStyle = "rgba(141,153,166,0.22)";
  context.beginPath();
  context.moveTo(padding.left, macdCenter);
  context.lineTo(width - padding.right, macdCenter);
  context.stroke();

  histogram.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    context.fillStyle = value >= 0 ? "rgba(98,230,167,0.5)" : "rgba(255,94,115,0.5)";
    const zero = macdY(0);
    const y = macdY(value);
    context.fillRect(x(index) - 1.5, Math.min(zero, y), 3, Math.max(1, Math.abs(y - zero)));
  });
  drawSeries(context, line, x, macdY, "#53d8fb");
  drawSeries(context, signal, x, macdY, "#ffcb6b");

  const rsiY = (value) => rsiBottom - (value / 100) * (rsiBottom - rsiTop);
  context.fillStyle = "rgba(255,94,115,0.07)";
  context.fillRect(padding.left, rsiY(100), plotWidth, rsiY(70) - rsiY(100));
  context.fillStyle = "rgba(83,216,251,0.025)";
  context.fillRect(padding.left, rsiY(70), plotWidth, rsiY(30) - rsiY(70));
  context.fillStyle = "rgba(83,216,251,0.065)";
  context.fillRect(padding.left, rsiY(30), plotWidth, rsiY(0) - rsiY(30));

  for (const level of [30, 50, 70]) {
    context.strokeStyle = level === 70
      ? "rgba(255,94,115,0.5)"
      : level === 30
        ? "rgba(83,216,251,0.5)"
        : "rgba(141,153,166,0.2)";
    context.setLineDash(level === 50 ? [3, 5] : []);
    context.beginPath();
    context.moveTo(padding.left, rsiY(level));
    context.lineTo(width - padding.right, rsiY(level));
    context.stroke();
    context.fillStyle = level === 70 ? "#ff5e73" : level === 30 ? "#53d8fb" : "#8d99a6";
    context.font = "10px ui-monospace, monospace";
    const levelLabel = level === 70 ? "70 超买" : level === 30 ? "30 超卖" : "50 中线";
    context.textAlign = "right";
    context.fillText(levelLabel, width - padding.right - 7, rsiY(level) + 3);
    context.textAlign = "left";
  }
  context.setLineDash([]);
  drawThresholdSeries(context, rsiValues, x, rsiY);

  const latestRsi = [...rsiValues].reverse().find(Number.isFinite);
  if (Number.isFinite(latestRsi)) drawRsiMarker(context, latestRsi, rsiY(latestRsi), width, padding);

  context.strokeStyle = "rgba(141,153,166,0.26)";
  context.beginPath();
  context.moveTo(padding.left, macdBottom + 12);
  context.lineTo(width - padding.right, macdBottom + 12);
  context.stroke();
  context.fillStyle = "#8d99a6";
  context.font = "10px ui-monospace, monospace";
  context.fillText("MACD · 动能与趋势", padding.left, 13);
  context.fillText("RSI 14 · 0–100 完整尺度", padding.left, rsiTop - 7);
  drawRsiLegend(context, padding.left + 176, rsiTop - 7);
  context.fillStyle = "rgba(255,94,115,0.58)";
  context.fillText("OVERBOUGHT · 超买区", padding.left + 8, rsiY(85) + 3);
  context.fillStyle = "rgba(83,216,251,0.64)";
  context.fillText("OVERSOLD · 超卖区", padding.left + 8, rsiY(15) + 3);
  drawIndicatorCrosshair(context, {
    bars,
    window: visibleWindow,
    hover,
    interval,
    width,
    height,
    padding,
    slot,
    rsiValues,
    line,
    signal,
    histogram,
  });
}

function drawLastPriceLine(context, geometry) {
  const { width, padding, minPrice, maxPrice, yPrice, rightOffset, lastBar } = geometry;
  if (rightOffset !== 0 || !lastBar || lastBar.close < minPrice || lastBar.close > maxPrice) return;
  const y = yPrice(lastBar.close);
  const color = lastBar.close >= lastBar.open ? "#62e6a7" : "#ff5e73";
  context.save();
  context.strokeStyle = color;
  context.globalAlpha = 0.65;
  context.setLineDash([3, 3]);
  context.beginPath();
  context.moveTo(padding.left, y);
  context.lineTo(width - padding.right, y);
  context.stroke();
  context.restore();
  drawAxisLabel(context, formatPrice(lastBar.close), width - padding.right + 2, y, color, width);
}

function drawPriceCrosshair(context, geometry) {
  const { hover } = geometry;
  if (!hover || hover.absoluteIndex < geometry.window.start || hover.absoluteIndex >= geometry.window.end) return;
  const localIndex = hover.absoluteIndex - geometry.window.start;
  const bar = geometry.bars[localIndex];
  const x = geometry.padding.left + geometry.slot * localIndex + geometry.slot / 2;
  const rawY = hover.source === "price" && Number.isFinite(hover.priceY)
    ? hover.priceY
    : geometry.yPrice(bar.close);
  const y = clamp(rawY, geometry.padding.top, geometry.priceBottom);
  const hoveredPrice = geometry.maxPrice
    - ((y - geometry.padding.top) / (geometry.priceBottom - geometry.padding.top))
      * (geometry.maxPrice - geometry.minPrice);

  context.save();
  context.fillStyle = "rgba(83, 216, 251, 0.055)";
  context.fillRect(
    x - geometry.slot / 2,
    geometry.padding.top,
    geometry.slot,
    geometry.height - geometry.padding.bottom - geometry.padding.top,
  );
  context.strokeStyle = "rgba(205, 218, 228, 0.72)";
  context.lineWidth = 1;
  context.setLineDash([5, 5]);
  context.beginPath();
  context.moveTo(x, geometry.padding.top);
  context.lineTo(x, geometry.height - geometry.padding.bottom);
  context.moveTo(geometry.padding.left, y);
  context.lineTo(geometry.width - geometry.padding.right, y);
  context.stroke();
  context.restore();

  drawAxisLabel(
    context,
    formatPrice(hoveredPrice),
    geometry.width - geometry.padding.right + 2,
    y,
    "#d7e2ea",
    geometry.width,
  );
  drawTimeLabel(
    context,
    formatCrosshairTime(bar.time, geometry.interval),
    x,
    geometry.height - geometry.padding.bottom + 3,
    geometry.width,
  );
  drawOhlcvTooltip(context, bar, geometry.padding.left + 8, geometry.padding.top + 7, geometry.width);
}

function drawOhlcvTooltip(context, bar, x, y, canvasWidth) {
  const change = bar.open === 0 ? 0 : ((bar.close - bar.open) / bar.open) * 100;
  const lineOne = `O ${formatPrice(bar.open)}   H ${formatPrice(bar.high)}   L ${formatPrice(bar.low)}   C ${formatPrice(bar.close)}`;
  const lineTwo = `V ${compactNumber(bar.volume)}   ${change >= 0 ? "+" : ""}${change.toFixed(3)}%`;
  context.save();
  context.font = "11px ui-monospace, monospace";
  const width = Math.min(370, Math.max(context.measureText(lineOne).width + 20, 210));
  const safeX = Math.min(x, canvasWidth - width - 6);
  context.fillStyle = "rgba(9, 11, 14, 0.9)";
  context.strokeStyle = "rgba(83, 216, 251, 0.34)";
  context.fillRect(safeX, y, width, 46);
  context.strokeRect(safeX, y, width, 46);
  context.fillStyle = "#d7e2ea";
  context.fillText(lineOne, safeX + 10, y + 18);
  context.fillStyle = change >= 0 ? "#62e6a7" : "#ff5e73";
  context.fillText(lineTwo, safeX + 10, y + 35);
  context.restore();
}

function drawAxisLabel(context, text, x, y, background, canvasWidth) {
  context.save();
  context.font = "10px ui-monospace, monospace";
  const width = Math.min(canvasWidth - x, context.measureText(text).width + 10);
  const height = 18;
  const top = Math.max(0, y - height / 2);
  context.fillStyle = background;
  context.fillRect(x, top, width, height);
  context.fillStyle = "#090b0e";
  context.fillText(text, x + 5, top + 12.5);
  context.restore();
}

function drawTimeLabel(context, text, centerX, y, canvasWidth) {
  context.save();
  context.font = "10px ui-monospace, monospace";
  const width = context.measureText(text).width + 12;
  const x = clamp(centerX - width / 2, 0, canvasWidth - width);
  context.fillStyle = "#d7e2ea";
  context.fillRect(x, y, width, 18);
  context.fillStyle = "#090b0e";
  context.fillText(text, x + 6, y + 12.5);
  context.restore();
}

function drawGrid(context, width, priceBottom, padding, minPrice, maxPrice, yPrice) {
  context.font = "11px ui-monospace, monospace";
  context.lineWidth = 1;
  for (let line = 0; line <= 4; line += 1) {
    const price = minPrice + ((maxPrice - minPrice) * line) / 4;
    const y = yPrice(price);
    context.strokeStyle = "rgba(141, 153, 166, 0.15)";
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillStyle = "#8d99a6";
    context.fillText(formatPrice(price), width - padding.right + 8, y + 4);
  }
  context.strokeStyle = "rgba(141, 153, 166, 0.22)";
  context.beginPath();
  context.moveTo(padding.left, priceBottom + 10);
  context.lineTo(width - padding.right, priceBottom + 10);
  context.stroke();
}

function drawRsiLegend(context, startX, baselineY) {
  const items = [
    { color: "#ff5e73", label: ">70 超买" },
    { color: "#c7ff3d", label: "30–70 中性" },
    { color: "#53d8fb", label: "<30 超卖" },
  ];
  let x = startX;
  context.save();
  context.font = "9px ui-monospace, monospace";
  for (const item of items) {
    context.fillStyle = item.color;
    context.fillRect(x, baselineY - 6, 12, 2);
    x += 17;
    context.fillText(item.label, x, baselineY);
    x += context.measureText(item.label).width + 18;
  }
  context.restore();
}

function drawRsiMarker(context, value, y, width, padding) {
  const color = value >= 70 ? "#ff5e73" : value <= 30 ? "#53d8fb" : "#c7ff3d";
  const text = value.toFixed(2);
  const x = width - padding.right + 4;
  context.save();
  context.strokeStyle = color;
  context.globalAlpha = 0.55;
  context.setLineDash([3, 4]);
  context.beginPath();
  context.moveTo(padding.left, y);
  context.lineTo(width - padding.right, y);
  context.stroke();
  context.globalAlpha = 1;
  context.font = "10px ui-monospace, monospace";
  const markerWidth = Math.min(padding.right - 5, context.measureText(text).width + 10);
  context.fillStyle = color;
  context.fillRect(x, y - 9, markerWidth, 18);
  context.fillStyle = "#090b0e";
  context.fillText(text, x + 5, y + 3.5);
  context.restore();
}

function drawThresholdSeries(context, values, x, y) {
  const colors = { overbought: "#ff5e73", neutral: "#c7ff3d", oversold: "#53d8fb" };
  context.save();
  context.lineWidth = 2;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const segment of splitThresholdSegments(values, 30, 70)) {
    context.strokeStyle = colors[segment.zone];
    context.beginPath();
    context.moveTo(x(segment.from.index), y(segment.from.value));
    context.lineTo(x(segment.to.index), y(segment.to.value));
    context.stroke();
  }
  context.restore();
}

function drawIndicatorCrosshair(context, geometry) {
  const { hover } = geometry;
  if (!hover || hover.absoluteIndex < geometry.window.start || hover.absoluteIndex >= geometry.window.end) return;
  const localIndex = hover.absoluteIndex - geometry.window.start;
  const x = geometry.padding.left + geometry.slot * localIndex + geometry.slot / 2;
  context.save();
  context.strokeStyle = "rgba(205, 218, 228, 0.68)";
  context.setLineDash([5, 5]);
  context.beginPath();
  context.moveTo(x, geometry.padding.top);
  context.lineTo(x, geometry.height - geometry.padding.bottom);
  context.stroke();
  context.restore();

  const text = [
    `MACD ${formatIndicator(geometry.line[localIndex])}`,
    `Signal ${formatIndicator(geometry.signal[localIndex])}`,
    `Hist ${formatIndicator(geometry.histogram[localIndex])}`,
    `RSI ${formatIndicator(geometry.rsiValues[localIndex])}`,
  ].join("   ");
  context.save();
  context.font = "10px ui-monospace, monospace";
  const tooltipWidth = Math.min(geometry.width - 16, context.measureText(text).width + 16);
  context.fillStyle = "rgba(9, 11, 14, 0.88)";
  context.strokeStyle = "rgba(83, 216, 251, 0.3)";
  context.fillRect(geometry.padding.left, 20, tooltipWidth, 24);
  context.strokeRect(geometry.padding.left, 20, tooltipWidth, 24);
  context.fillStyle = "#d7e2ea";
  context.fillText(text, geometry.padding.left + 8, 36);
  context.restore();
  drawTimeLabel(
    context,
    formatCrosshairTime(geometry.bars[localIndex].time, geometry.interval),
    x,
    geometry.height - 19,
    geometry.width,
  );
}

function drawSeries(context, values, x, y, color) {
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  context.beginPath();
  let started = false;
  let hasPoint = false;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      started = false;
      return;
    }
    if (!started) {
      context.moveTo(x(index), y(value));
      started = true;
    } else {
      context.lineTo(x(index), y(value));
    }
    hasPoint = true;
  });
  if (hasPoint) context.stroke();
}

function prepareCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(300, canvas.clientWidth);
  const configuredHeight = Number(canvas.dataset.logicalHeight ?? 320);
  const cssHeight = Number.parseFloat(window.getComputedStyle(canvas).height);
  const height = Number.isFinite(cssHeight) && cssHeight > 0 ? cssHeight : configuredHeight;
  if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}
