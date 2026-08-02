import { clamp } from "./view.mjs";
import {
  compactNumber,
  formatCrosshairTime,
  formatPrice,
} from "../formatters.mjs";

export const PRICE_PADDING = Object.freeze({ top: 24, right: 78, bottom: 34, left: 12 });

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

export function drawAxisLabel(context, text, x, y, background, canvasWidth) {
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

export function drawTimeLabel(context, text, centerX, y, canvasWidth) {
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

export function drawSeries(context, values, x, y, color, lineWidth = 1.5) {
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
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

export function prepareCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  // 绘图和 pointer 几何都使用真实 CSS 宽度，窄屏时不能另设最小逻辑宽度。
  const width = Math.max(1, canvas.clientWidth);
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
