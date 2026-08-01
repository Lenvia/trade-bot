import { calculateIndicatorSet, EMPTY_INDICATOR_SET } from "/indicator-set.mjs";
import {
  applyTradeToBars,
  createTradeDeduper,
  reconcileHistoryWithTrades,
  replayTradesOnBars,
} from "/live-data.mjs";
import { BybitPublicSource } from "/data-sources/bybit-public.mjs";
import { assertMarketDataSource } from "/market-data-contract.mjs";
import {
  drawIndicatorChart,
  drawPriceChart,
  INDICATOR_PADDING,
  PRICE_PADDING,
} from "/chart-renderer.mjs";
import {
  compactNumber,
  formatCrosshairTime as formatTime,
  formatIndicator,
  formatPrice,
} from "/formatters.mjs";
import {
  DEFAULT_VISIBLE_BARS,
  clamp,
  getVisibleWindow,
  indexFromPlotX,
  minimumVisibleBarsForPlotWidth,
  panWindow,
  zoomWindow,
} from "/chart-view.mjs";

const MAX_TRADES = 40;
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const STREAM_DELAYED_AFTER_MS = 5_000;
const STREAM_STALE_AFTER_MS = 15_000;
const intervalMilliseconds = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "1D": 86_400_000,
};

const elements = Object.fromEntries(
  [
    "symbolSelect", "intervalSelect", "rowsSelect", "connectButton", "refreshButton",
    "statusDot", "statusText", "openValue", "highValue", "lowValue", "closeValue",
    "volumeValue", "barTimeValue", "rsiValue", "rsiReading", "macdValue",
    "macdReading", "tradeCount", "tradeTableBody", "debugLog", "emptyState",
    "priceCanvas", "indicatorCanvas", "zoomOutButton", "zoomInButton",
    "resetViewButton", "visibleRangeLabel",
    "streamBadge", "lastTradeAge", "transportDelay", "historySyncStatus",
    "metricReadMode",
  ].map((id) => [id, document.getElementById(id)]),
);

const state = {
  bars: [],
  indicators: EMPTY_INDICATOR_SET,
  historyLoad: null,
  loadedSelection: null,
  trades: [],
  reconcileTimer: null,
  freshnessTimer: null,
  lastTradeReceivedAt: null,
  lastTradeExchangeAt: null,
  lastTransportDelayMs: null,
  lastHistorySyncAt: null,
  renderScheduled: false,
  view: {
    visibleCount: DEFAULT_VISIBLE_BARS,
    rightOffset: 0,
    hover: null,
    dragging: false,
    dragStartX: 0,
    dragStartOffset: 0,
  },
};

const tradeDeduper = createTradeDeduper();
const dataSource = assertMarketDataSource(new BybitPublicSource({
  callbacks: {
    onConnectionState: handleConnectionState,
    onHistoryStart: beginHistoryLoad,
    onHistory: completeHistoryLoad,
    onHistoryError: failHistoryLoad,
    onTrades: receiveTrades,
    onLog: log,
  },
}));

elements.connectButton.addEventListener("click", () => connect());
elements.refreshButton.addEventListener("click", () => requestHistory());
elements.symbolSelect.addEventListener("change", () => changeSelection({ symbolChanged: true }));
elements.intervalSelect.addEventListener("change", () => changeSelection());
elements.rowsSelect.addEventListener("change", () => changeSelection());
window.addEventListener("resize", scheduleRender);
window.addEventListener("beforeunload", () => dataSource.disconnect());
document.addEventListener("visibilitychange", handleVisibilityChange);
setupChartInteractions();
startFreshnessTimer();

function connect() {
  resetTradeStream();
  dataSource.connect(currentSelection());
}

function currentSelection() {
  return {
    symbol: elements.symbolSelect.value,
    interval: elements.intervalSelect.value,
    rows: Number(elements.rowsSelect.value),
  };
}

function requestHistory(options) {
  return dataSource.requestHistory(options);
}

function changeSelection({ symbolChanged = false } = {}) {
  if (symbolChanged) resetTradeStream();
  dataSource.updateSelection(currentSelection());
}

function resetTradeStream() {
  state.trades = [];
  state.lastTradeReceivedAt = null;
  state.lastTradeExchangeAt = null;
  state.lastTransportDelayMs = null;
  tradeDeduper.clear();
  renderTrades();
  updateStreamHealth();
}

function handleConnectionState({ kind, message, canRefresh }) {
  setStatus(kind, message);
  elements.refreshButton.disabled = !canRefresh;
  if (kind === "connected") startReconcileTimer();
  else if (!canRefresh) clearReconcileTimer();
  updateStreamHealth();
}

function beginHistoryLoad(request) {
  const baselineIsCompatible = sameMarketSeries(state.loadedSelection, request.selection);
  state.historyLoad = {
    request,
    baseline: baselineIsCompatible ? state.bars.map((bar) => ({ ...bar })) : [],
    trades: [],
    previousHistorySyncAt: baselineIsCompatible ? state.lastHistorySyncAt : null,
  };
  if (request.background) return;

  setBars([]);
  state.lastHistorySyncAt = null;
  state.view.hover = null;
  state.view.rightOffset = 0;
  elements.emptyState.hidden = false;
  setStatus("connecting", "正在读取历史 K 线…");
  scheduleRender();
}

function completeHistoryLoad({ request, bars }) {
  const load = state.historyLoad;
  if (!load || load.request.requestId !== request.requestId) return;

  const interval = intervalMilliseconds[request.selection.interval];
  setBars(reconcileHistoryWithTrades(bars, load.baseline, load.trades, interval));
  state.historyLoad = null;
  state.loadedSelection = { ...request.selection };
  state.lastHistorySyncAt = Date.now();

  if (request.background) {
    log(`Background history reconcile complete: ${bars.length} bars checked.`);
  } else {
    resetView();
    log(`History complete: ${state.bars.length} normalized bars.`);
  }
  setStatus("connected", `实时接收中 · ${state.bars.length} 根 K 线`);
  elements.emptyState.hidden = state.bars.length > 0;
  updateStreamHealth();
  scheduleRender();
}

function failHistoryLoad({ request, message, reason }) {
  const load = state.historyLoad;
  if (!load || load.request.requestId !== request.requestId) return;
  const interval = intervalMilliseconds[request.selection.interval];
  setBars(replayTradesOnBars(load.baseline, load.trades, interval));
  state.historyLoad = null;
  state.lastHistorySyncAt = load.previousHistorySyncAt;
  elements.emptyState.hidden = state.bars.length > 0;
  scheduleRender();
  if (reason === "superseded") return;
  if (request.background) {
    log(`Background history reconcile skipped: ${message}`);
  } else {
    setStatus("error", reason === "timeout" ? "历史数据读取超时" : "历史数据读取失败");
    elements.emptyState.hidden = false;
  }
  updateStreamHealth();
}

function sameMarketSeries(left, right) {
  return left?.symbol === right?.symbol && left?.interval === right?.interval;
}

function setBars(bars) {
  state.bars = bars;
  state.indicators = calculateIndicatorSet(bars);
}

function startReconcileTimer() {
  clearReconcileTimer();
  state.reconcileTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") requestHistory({ background: true });
  }, RECONCILE_INTERVAL_MS);
}

function clearReconcileTimer() {
  if (state.reconcileTimer !== null) window.clearInterval(state.reconcileTimer);
  state.reconcileTimer = null;
}

function receiveTrades(incoming) {
  if (incoming.length === 0) return;

  let barsUpdated = false;
  for (const trade of incoming) {
    if (!tradeDeduper.accepts(trade)) continue;
    if (state.historyLoad) state.historyLoad.trades.push(trade);
    state.trades.unshift(trade);
    state.lastTradeReceivedAt = Date.now();
    state.lastTradeExchangeAt = Math.max(state.lastTradeExchangeAt ?? 0, trade.time);
    const canUpdateVisibleBars = !state.historyLoad || state.historyLoad.request.background;
    if (canUpdateVisibleBars) barsUpdated = updateCurrentBar(trade).updated || barsUpdated;
  }
  if (barsUpdated) state.indicators = calculateIndicatorSet(state.bars);
  state.trades = state.trades.slice(0, MAX_TRADES);
  state.lastTransportDelayMs = state.lastTradeExchangeAt == null
    ? null
    : Math.max(0, Date.now() - state.lastTradeExchangeAt);
  updateStreamHealth();
  renderTrades();
  scheduleRender();
}

function updateCurrentBar(trade) {
  const interval = intervalMilliseconds[elements.intervalSelect.value];
  if (!interval) return { updated: false, created: false };
  const result = applyTradeToBars(state.bars, trade, interval);
  if (result.created) {
    if (state.view.rightOffset > 0) state.view.rightOffset += 1;
    setStatus("connected", `实时接收中 · ${state.bars.length} 根 K 线`);
  }
  return result;
}

function render() {
  state.renderScheduled = false;
  renderMetrics();
  renderVisibleRange();
  const visibleWindow = currentVisibleWindow();
  const interval = elements.intervalSelect.value;
  drawPriceChart({
    canvas: elements.priceCanvas,
    allBars: state.bars,
    visibleWindow,
    hover: state.view.hover,
    rightOffset: state.view.rightOffset,
    interval,
  });
  drawIndicatorChart({
    canvas: elements.indicatorCanvas,
    allBars: state.bars,
    indicators: state.indicators,
    visibleWindow,
    hover: state.view.hover,
    interval,
  });
}

function scheduleRender() {
  if (state.renderScheduled) return;
  state.renderScheduled = true;
  window.requestAnimationFrame(render);
}

function setupChartInteractions() {
  for (const canvas of [elements.priceCanvas, elements.indicatorCanvas]) {
    const source = canvas === elements.priceCanvas ? "price" : "indicator";
    canvas.addEventListener("pointermove", (event) => handlePointerMove(event, source));
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerUp);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("wheel", (event) => handleWheel(event, source), { passive: false });
    canvas.addEventListener("dblclick", resetView);
  }

  // 工具栏缩放没有鼠标锚点，默认保留最新 K 线；滚轮仍围绕指针缩放。
  elements.zoomInButton.addEventListener("click", () => zoomAt(1, 0.78));
  elements.zoomOutButton.addEventListener("click", () => zoomAt(1, 1.28));
  elements.resetViewButton.addEventListener("click", resetView);
}

function handlePointerMove(event, source) {
  if (state.bars.length === 0) return;
  const canvas = event.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const padding = source === "price" ? PRICE_PADDING : INDICATOR_PADDING;
  const plotWidth = Math.max(1, rect.width - padding.left - padding.right);

  if (state.view.dragging) {
    const window = currentVisibleWindow();
    const deltaBars = ((event.clientX - state.view.dragStartX) / plotWidth) * window.count;
    const next = panWindow(
      state.bars.length,
      state.view.visibleCount,
      state.view.dragStartOffset,
      deltaBars,
    );
    state.view.rightOffset = next.rightOffset;
    state.view.hover = null;
    scheduleRender();
    return;
  }

  const window = currentVisibleWindow();
  const absoluteIndex = indexFromPlotX(x, padding.left, plotWidth, window);
  if (absoluteIndex === null) return;
  state.view.hover = {
    absoluteIndex,
    source,
    priceY: source === "price" ? y : null,
  };
  scheduleRender();
}

function handlePointerDown(event) {
  if (state.bars.length === 0 || event.button !== 0) return;
  state.view.dragging = true;
  state.view.dragStartX = event.clientX;
  state.view.dragStartOffset = state.view.rightOffset;
  event.currentTarget.classList.add("is-dragging");
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function handlePointerUp(event) {
  if (!state.view.dragging) return;
  state.view.dragging = false;
  event.currentTarget.classList.remove("is-dragging");
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  scheduleRender();
}

function handlePointerLeave(event) {
  if (state.view.dragging) return;
  event.currentTarget.classList.remove("is-dragging");
  state.view.hover = null;
  scheduleRender();
}

function handleWheel(event, source) {
  if (state.bars.length === 0) return;
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  const padding = source === "price" ? PRICE_PADDING : INDICATOR_PADDING;
  const plotWidth = Math.max(1, rect.width - padding.left - padding.right);
  const ratio = clamp((event.clientX - rect.left - padding.left) / plotWidth, 0, 1);
  zoomAt(ratio, event.deltaY < 0 ? 0.82 : 1.22);
}

function zoomAt(pointerRatio, scale) {
  if (state.bars.length === 0) return;
  const plotWidth = Math.max(
    1,
    elements.priceCanvas.clientWidth - PRICE_PADDING.left - PRICE_PADDING.right,
  );
  const minimumVisibleBars = minimumVisibleBarsForPlotWidth(plotWidth);
  const next = zoomWindow(
    state.bars.length,
    state.view.visibleCount,
    state.view.rightOffset,
    pointerRatio,
    scale,
    minimumVisibleBars,
  );
  state.view.visibleCount = next.visibleCount;
  state.view.rightOffset = next.rightOffset;
  state.view.hover = null;
  scheduleRender();
}

function resetView() {
  state.view.visibleCount = Math.min(DEFAULT_VISIBLE_BARS, Math.max(1, state.bars.length));
  state.view.rightOffset = 0;
  state.view.hover = null;
  state.view.dragging = false;
  elements.priceCanvas.classList.remove("is-dragging");
  elements.indicatorCanvas.classList.remove("is-dragging");
  scheduleRender();
}

function currentVisibleWindow() {
  return getVisibleWindow(
    state.bars.length,
    state.view.visibleCount,
    state.view.rightOffset,
  );
}

function renderVisibleRange() {
  const window = currentVisibleWindow();
  if (window.count === 0) {
    elements.visibleRangeLabel.textContent = "等待数据";
    return;
  }
  elements.visibleRangeLabel.textContent = `${window.count} 根 · ${window.start + 1}–${window.end} / ${state.bars.length}`;
}

function renderMetrics() {
  const hoverIndex = state.view.hover?.absoluteIndex;
  const isCrosshairReadout = Number.isInteger(hoverIndex) && Boolean(state.bars[hoverIndex]);
  const bar = Number.isInteger(hoverIndex) && state.bars[hoverIndex]
    ? state.bars[hoverIndex]
    : state.bars.at(-1);
  if (!bar) {
    elements.metricReadMode.textContent = "LIVE · 等待 K 线";
    elements.metricReadMode.classList.remove("crosshair");
    for (const element of [
      elements.openValue,
      elements.highValue,
      elements.lowValue,
      elements.closeValue,
      elements.volumeValue,
      elements.barTimeValue,
      elements.rsiValue,
      elements.macdValue,
    ]) element.textContent = "—";
    elements.rsiReading.textContent = "等待数据";
    elements.macdReading.textContent = "等待数据";
    return;
  }

  elements.metricReadMode.textContent = isCrosshairReadout
    ? `CROSSHAIR · ${formatCrosshairTime(bar.time)}`
    : "LIVE · 最新 K 线";
  elements.metricReadMode.classList.toggle("crosshair", isCrosshairReadout);
  elements.openValue.textContent = formatPrice(bar.open);
  elements.highValue.textContent = formatPrice(bar.high);
  elements.lowValue.textContent = formatPrice(bar.low);
  elements.closeValue.textContent = formatPrice(bar.close);
  elements.volumeValue.textContent = compactNumber(bar.volume);
  elements.barTimeValue.textContent = new Date(bar.time).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });

  const rsiValues = state.indicators.rsi14;
  const macdValues = state.indicators.macd12_26_9;
  const metricIndex = Number.isInteger(hoverIndex) && state.bars[hoverIndex]
    ? hoverIndex
    : state.bars.length - 1;
  const latestRsi = rsiValues[metricIndex] ?? null;
  const latestMacd = macdValues.line[metricIndex] ?? null;
  const latestSignal = macdValues.signal[metricIndex] ?? null;
  const latestHistogram = macdValues.histogram[metricIndex] ?? null;

  elements.rsiValue.textContent = formatIndicator(latestRsi);
  elements.rsiReading.textContent = rsiDescription(latestRsi);
  elements.macdValue.textContent = latestMacd === null ? "—" : `${formatIndicator(latestMacd)} / ${formatIndicator(latestSignal)}`;
  elements.macdReading.textContent = latestHistogram === null
    ? "等待足够历史数据"
    : `Histogram ${formatIndicator(latestHistogram)} · ${latestHistogram >= 0 ? "动能偏多" : "动能偏空"}`;
}

function renderTrades() {
  elements.tradeCount.textContent = `${state.trades.length} trades`;
  if (state.trades.length === 0) {
    elements.tradeTableBody.innerHTML = '<tr><td colspan="4" class="placeholder-row">等待实时成交…</td></tr>';
    return;
  }
  elements.tradeTableBody.innerHTML = state.trades.map((trade) => {
    const normalizedSide = trade.side.toLowerCase();
    const sideClass = normalizedSide === "buy" ? "buy" : normalizedSide === "sell" ? "sell" : "neutral";
    return `<tr>
      <td>${new Date(trade.time).toLocaleTimeString("zh-CN", { hour12: false })}</td>
      <td class="${sideClass}">${escapeHtml(trade.side)}</td>
      <td>${formatPrice(trade.price)}</td>
      <td>${compactNumber(trade.size)}</td>
    </tr>`;
  }).join("");
}

function startFreshnessTimer() {
  if (state.freshnessTimer) window.clearInterval(state.freshnessTimer);
  state.freshnessTimer = window.setInterval(updateStreamHealth, 1000);
  updateStreamHealth();
}

function updateStreamHealth() {
  const now = Date.now();
  const isOpen = dataSource.isOpen;
  const receiveAge = state.lastTradeReceivedAt == null ? null : now - state.lastTradeReceivedAt;
  const transportDelay = state.lastTransportDelayMs;

  let badge = "OFFLINE";
  let badgeClass = "idle";
  let ageText = isOpen ? "等待首笔 tick" : "等待连接";
  if (isOpen && receiveAge != null) {
    if (receiveAge <= STREAM_DELAYED_AFTER_MS) {
      badge = "LIVE";
      badgeClass = "live";
    } else if (receiveAge <= STREAM_STALE_AFTER_MS) {
      badge = "DELAYED";
      badgeClass = "delayed";
    } else {
      badge = "STALE";
      badgeClass = "stale";
    }
    ageText = `最后 tick ${formatAge(receiveAge)}前`;
  } else if (isOpen) {
    badge = "CONNECTED";
    badgeClass = "delayed";
  }

  elements.streamBadge.textContent = badge;
  elements.streamBadge.className = `stream-badge ${badgeClass}`;
  elements.lastTradeAge.textContent = ageText;
  elements.transportDelay.textContent = transportDelay == null
    ? "—"
    : `约 ${formatAge(transportDelay)}`;
  elements.historySyncStatus.textContent = state.lastHistorySyncAt == null
    ? "等待首次加载"
    : `${formatAge(now - state.lastHistorySyncAt)}前 · 每 5m 校准`;
}

function formatAge(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1000) return "<1s";
  if (milliseconds < 60_000) return `${Math.floor(milliseconds / 1000)}s`;
  return `${Math.floor(milliseconds / 60_000)}m`;
}

function handleVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  if (dataSource.isOpen) {
    const sinceSync = Date.now() - (state.lastHistorySyncAt ?? 0);
    if (sinceSync > 15_000) requestHistory({ background: true });
    return;
  }
  dataSource.reconnectNow();
}

function setStatus(kind, text) {
  elements.statusDot.className = `status-dot ${kind}`;
  elements.statusText.textContent = text;
}

function log(message) {
  const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const previous = elements.debugLog.textContent === "尚无日志。" ? "" : elements.debugLog.textContent;
  elements.debugLog.textContent = `[${timestamp}] ${message}\n${previous}`.slice(0, 10_000);
}

function formatCrosshairTime(time) {
  return formatTime(time, elements.intervalSelect.value);
}

function rsiDescription(value) {
  if (!Number.isFinite(value)) return "等待足够历史数据";
  if (value >= 70) return "高于 70 · 常被视为偏热区间";
  if (value <= 30) return "低于 30 · 常被视为偏冷区间";
  return "30–70 · 中性区间";
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

scheduleRender();
connect();
