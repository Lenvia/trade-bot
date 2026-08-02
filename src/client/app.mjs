import {
  calculateIndicatorSet,
  DEFAULT_INDICATOR_IDS,
  EMPTY_INDICATOR_SET,
  INDICATOR_REGISTRY,
} from "/src/client/indicators/builtins.mjs";
import {
  applyTradeToBars,
  createTradeDeduper,
  reconcileHistoryWithTrades,
  replayTradesOnBars,
} from "/src/client/market/live-data.mjs";
import { BybitPublicSource } from "/src/client/market/sources/bybit-public.mjs";
import { assertMarketDataSource } from "/src/client/market/contract.mjs";
import { deriveStreamHealth } from "/src/client/market/health.mjs";
import { drawPriceChart, PRICE_PADDING } from "/src/client/charts/price-renderer.mjs";
import { drawIndicatorPane, INDICATOR_PADDING } from "/src/client/charts/indicator-renderer.mjs";
import {
  compactNumber,
  formatCrosshairTime as formatTime,
  formatIndicator,
  formatPrice,
} from "/src/client/formatters.mjs";
import {
  DEFAULT_VISIBLE_BARS,
  clamp,
  getVisibleWindow,
  indexFromPlotX,
  minimumVisibleBarsForPlotWidth,
  panWindow,
  zoomWindow,
} from "/src/client/charts/view.mjs";

const MAX_TRADES = 40;
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const VISIBILITY_RECONCILE_MIN_MS = 60_000;
const NETWORK_ROUTE_REFRESH_MS = 15_000;
const QUICK_INTERVALS = new Set(["15m", "1h", "4h", "1D"]);
const intervalMilliseconds = Object.freeze({
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "12h": 43_200_000,
  "1D": 86_400_000,
});

const elements = Object.fromEntries(
  [
    "intervalMenu", "rowsSelect", "connectButton", "refreshButton",
    "statusDot", "statusText", "openValue", "highValue", "lowValue", "closeValue",
    "volumeValue", "barTimeValue", "tradeCount", "tradeTableBody", "debugLog",
    "emptyState", "priceCanvas", "zoomOutButton", "zoomInButton", "resetViewButton",
    "visibleRangeLabel", "streamBadge", "lastTradeAge", "transportDelay",
    "historySyncStatus", "metricReadMode", "indicatorOptions", "activeIndicatorCount",
    "indicatorPanes", "indicatorEmpty", "chartTitle", "routeStatus", "routeBadge", "routeText",
    "diagnosticSummary", "diagnosticWs", "diagnosticHistory", "diagnosticRoute", "diagnosticLastError",
  ].map((id) => [id, document.getElementById(id)]),
);

const state = {
  selection: { symbol: "BYBIT:FUTURE:BNBUSDT", interval: "15m", rows: 200 },
  activeIndicatorIds: [...DEFAULT_INDICATOR_IDS],
  bars: [],
  indicators: EMPTY_INDICATOR_SET,
  historyLoad: null,
  barSelection: null,
  trades: [],
  reconcileTimer: null,
  freshnessTimer: null,
  routeTimer: null,
  routeProbeInFlight: false,
  lastTradeReceivedAt: null,
  lastTradeExchangeAt: null,
  lastTransportActivityAt: null,
  lastTransportDelayMs: null,
  lastHistorySyncAt: null,
  connection: { kind: "idle", message: "尚未连接", canRefresh: false },
  historyHealth: {
    status: "idle",
    attempt: 0,
    retryAt: null,
    lastAttemptAt: null,
    lastError: null,
    barCount: 0,
  },
  routeHealth: { text: "检查中", detail: "正在检查系统代理" },
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

const indicatorPanes = new Map();
const tradeDeduper = createTradeDeduper();
const dataSource = assertMarketDataSource(new BybitPublicSource({
  callbacks: {
    onConnectionState: handleConnectionState,
    onHistoryStart: beginHistoryLoad,
    onHistory: completeHistoryLoad,
    onHistoryError: failHistoryLoad,
    onHistoryRetry: handleHistoryRetry,
    onTrades: receiveTrades,
    onTransportActivity: handleTransportActivity,
    onLog: log,
  },
}));

function initialize() {
  renderIndicatorOptions();
  syncIndicatorPanes();
  syncSelectionControls();
  bindChartCanvas(elements.priceCanvas, "price");
  setupEventListeners();
  startFreshnessTimer();
  startNetworkRouteMonitor();
  scheduleRender();
  connect();
}

function setupEventListeners() {
  elements.connectButton.addEventListener("click", connect);
  elements.refreshButton.addEventListener("click", () => requestHistory());
  elements.rowsSelect.addEventListener("change", () => setRows(Number(elements.rowsSelect.value)));
  elements.intervalMenu.addEventListener("change", () => {
    if (elements.intervalMenu.value) setTimeframe(elements.intervalMenu.value);
  });
  document.querySelectorAll("[data-interval]").forEach((button) => {
    button.addEventListener("click", () => setTimeframe(button.dataset.interval));
  });
  document.querySelectorAll("[data-symbol]").forEach((button) => {
    button.addEventListener("click", () => setSymbol(button.dataset.symbol));
  });
  elements.zoomInButton.addEventListener("click", () => zoomAt(1, 0.78));
  elements.zoomOutButton.addEventListener("click", () => zoomAt(1, 1.28));
  elements.resetViewButton.addEventListener("click", resetView);
  window.addEventListener("resize", scheduleRender);
  window.addEventListener("beforeunload", () => dataSource.disconnect());
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

function connect() {
  resetTradeStream();
  dataSource.connect(currentSelection());
}

function currentSelection() {
  return { ...state.selection };
}

function requestHistory(options) {
  return dataSource.requestHistory(options);
}

function setTimeframe(interval) {
  if (!intervalMilliseconds[interval]) throw new RangeError(`Unsupported interval: ${interval}`);
  if (state.selection.interval === interval) return;
  state.selection.interval = interval;
  syncSelectionControls();
  changeSelection();
}

function setSymbol(symbol) {
  if (state.selection.symbol === symbol) return;
  state.selection.symbol = symbol;
  syncSelectionControls();
  resetTradeStream();
  changeSelection();
}

function setRows(rows) {
  if (!Number.isInteger(rows) || rows <= 0 || state.selection.rows === rows) return;
  state.selection.rows = rows;
  changeSelection();
}

function changeSelection() {
  state.view.hover = null;
  dataSource.updateSelection(currentSelection());
}

function syncSelectionControls() {
  const { symbol, interval, rows } = state.selection;
  elements.rowsSelect.value = String(rows);
  elements.intervalMenu.value = QUICK_INTERVALS.has(interval) ? "" : interval;
  document.querySelectorAll("[data-interval]").forEach((button) => {
    const active = button.dataset.interval === interval;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll("[data-symbol]").forEach((button) => {
    const active = button.dataset.symbol === symbol;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  elements.chartTitle.textContent = `${displaySymbol(symbol)} · ${interval}`;
}

function displaySymbol(symbol) {
  return symbol.split(":").at(-1) ?? symbol;
}

function renderIndicatorOptions() {
  elements.indicatorOptions.replaceChildren();
  for (const definition of INDICATOR_REGISTRY.list()) {
    const label = document.createElement("label");
    label.className = "indicator-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.activeIndicatorIds.includes(definition.id);
    checkbox.dataset.indicatorId = definition.id;
    checkbox.addEventListener("change", () => toggleIndicator(definition.id, checkbox.checked));
    const text = document.createElement("span");
    text.innerHTML = `<strong>${escapeHtml(definition.shortLabel)}</strong><small>${escapeHtml(definition.label)}</small>`;
    label.append(checkbox, text);
    elements.indicatorOptions.append(label);
  }
}

function toggleIndicator(id, enabled) {
  if (!INDICATOR_REGISTRY.has(id)) throw new RangeError(`Unknown indicator: ${id}`);
  const active = new Set(state.activeIndicatorIds);
  if (enabled) active.add(id);
  else active.delete(id);
  state.activeIndicatorIds = INDICATOR_REGISTRY.list()
    .map(({ id: definitionId }) => definitionId)
    .filter((definitionId) => active.has(definitionId));
  state.indicators = calculateIndicatorSet(state.bars, state.activeIndicatorIds);
  syncIndicatorPanes();
  syncIndicatorOptions();
  scheduleRender();
}

function syncIndicatorOptions() {
  elements.activeIndicatorCount.textContent = String(state.activeIndicatorIds.length);
  elements.indicatorOptions.querySelectorAll("[data-indicator-id]").forEach((checkbox) => {
    checkbox.checked = state.activeIndicatorIds.includes(checkbox.dataset.indicatorId);
  });
}

function syncIndicatorPanes() {
  const active = new Set(state.activeIndicatorIds);
  for (const [id, pane] of indicatorPanes) {
    if (active.has(id)) continue;
    if (pane.canvas.classList.contains("is-dragging")) cancelDrag();
    pane.root.remove();
    indicatorPanes.delete(id);
  }

  state.activeIndicatorIds.forEach((id, index) => {
    let pane = indicatorPanes.get(id);
    if (!pane) {
      pane = createIndicatorPane(INDICATOR_REGISTRY.get(id), index);
      indicatorPanes.set(id, pane);
    }
    pane.index.textContent = `02.${index + 1}`;
    elements.indicatorPanes.append(pane.root);
  });
  elements.indicatorEmpty.hidden = state.activeIndicatorIds.length > 0;
  syncIndicatorOptions();
}

function createIndicatorPane(definition, index) {
  const root = document.createElement("section");
  root.className = "indicator-pane";
  root.dataset.indicatorId = definition.id;

  const header = document.createElement("div");
  header.className = "indicator-pane-header";
  const title = document.createElement("div");
  const indexLabel = document.createElement("span");
  indexLabel.className = "section-index";
  indexLabel.textContent = `02.${index + 1}`;
  const heading = document.createElement("h3");
  heading.textContent = definition.shortLabel;
  title.append(indexLabel, heading);

  const readouts = document.createElement("div");
  readouts.className = "indicator-readouts";
  const readoutElements = new Map();
  for (const readout of definition.pane.readouts) {
    const item = document.createElement("span");
    item.innerHTML = `${escapeHtml(readout.label)} <strong>—</strong>`;
    readouts.append(item);
    readoutElements.set(readout.key, item.querySelector("strong"));
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "indicator-remove";
  remove.textContent = "移除";
  remove.setAttribute("aria-label", `移除 ${definition.shortLabel}`);
  remove.addEventListener("click", () => toggleIndicator(definition.id, false));
  header.append(title, readouts, remove);

  const canvas = document.createElement("canvas");
  canvas.className = "indicator-canvas";
  canvas.dataset.logicalHeight = String(definition.pane.height);
  canvas.height = definition.pane.height;
  canvas.style.height = `${definition.pane.height}px`;
  canvas.setAttribute("aria-label", `${definition.label} 指标图表`);
  bindChartCanvas(canvas, "indicator");
  root.append(header, canvas);
  return { root, canvas, index: indexLabel, readouts: readoutElements };
}

function resetTradeStream() {
  state.trades = [];
  state.lastTradeReceivedAt = null;
  state.lastTradeExchangeAt = null;
  state.lastTransportActivityAt = null;
  state.lastTransportDelayMs = null;
  tradeDeduper.clear();
  renderTrades();
  updateStreamHealth();
}

function handleConnectionState({ kind, message, canRefresh }) {
  state.connection = { kind, message, canRefresh };
  elements.refreshButton.disabled = !canRefresh;
  if (kind === "connected") startReconcileTimer();
  else if (!canRefresh) clearReconcileTimer();
  renderConnectionSummary();
  updateStreamHealth();
}

function beginHistoryLoad(request) {
  const baselineIsCompatible = sameMarketSeries(state.barSelection, request.selection);
  state.historyLoad = {
    request,
    baseline: baselineIsCompatible ? state.bars.map((bar) => ({ ...bar })) : [],
    trades: [],
    previousHistorySyncAt: baselineIsCompatible ? state.lastHistorySyncAt : null,
  };
  state.historyHealth = {
    ...state.historyHealth,
    status: "loading",
    attempt: request.retryAttempt ?? 0,
    retryAt: null,
    lastAttemptAt: Date.now(),
    lastError: null,
  };
  if (request.background) {
    renderConnectionSummary();
    updateStreamHealth();
    return;
  }

  if (!baselineIsCompatible) {
    setBars([]);
    state.lastHistorySyncAt = null;
  }
  state.barSelection = { ...request.selection };
  state.view.hover = null;
  state.view.rightOffset = 0;
  elements.emptyState.hidden = state.bars.length > 0;
  renderConnectionSummary();
  updateStreamHealth();
  scheduleRender();
}

function completeHistoryLoad({ request, bars }) {
  const load = state.historyLoad;
  if (!load || load.request.requestId !== request.requestId) return;
  const interval = intervalMilliseconds[request.selection.interval];
  setBars(reconcileHistoryWithTrades(bars, load.baseline, load.trades, interval));
  state.historyLoad = null;
  state.barSelection = { ...request.selection };
  state.lastHistorySyncAt = Date.now();
  state.historyHealth = {
    status: "ok",
    attempt: 0,
    retryAt: null,
    lastAttemptAt: state.historyHealth.lastAttemptAt,
    lastError: null,
    barCount: state.bars.length,
  };
  if (request.background) log(`Background history reconcile complete: ${bars.length} bars checked.`);
  else {
    resetView();
    log(`History complete: ${state.bars.length} normalized bars.`);
  }
  elements.emptyState.hidden = state.bars.length > 0;
  renderConnectionSummary();
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
  state.historyHealth = {
    ...state.historyHealth,
    status: "error",
    retryAt: null,
    lastError: message,
    barCount: state.bars.length,
  };
  elements.emptyState.hidden = state.bars.length > 0;
  scheduleRender();
  if (reason === "superseded") return;
  if (request.background) log(`Background history reconcile skipped: ${message}`);
  else if (state.bars.length === 0) elements.emptyState.hidden = false;
  renderConnectionSummary();
  updateStreamHealth();
}

function handleHistoryRetry({ attempt, delay, retryAt, message, selection }) {
  if (!sameMarketSeries(state.selection, selection)) return;
  state.historyHealth = {
    ...state.historyHealth,
    status: "retry",
    attempt,
    retryAt,
    lastError: message,
  };
  log(`历史数据将在 ${formatAge(delay)} 后自动重试（第 ${attempt} 次）。`);
  renderConnectionSummary();
  updateStreamHealth();
}

function handleTransportActivity({ receivedAt }) {
  state.lastTransportActivityAt = Math.max(state.lastTransportActivityAt ?? 0, receivedAt);
  updateStreamHealth();
}

function sameMarketSeries(left, right) {
  return left?.symbol === right?.symbol && left?.interval === right?.interval;
}

function setBars(bars) {
  state.bars = bars;
  state.indicators = calculateIndicatorSet(bars, state.activeIndicatorIds);
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
  if (barsUpdated) state.indicators = calculateIndicatorSet(state.bars, state.activeIndicatorIds);
  state.trades = state.trades.slice(0, MAX_TRADES);
  state.lastTransportDelayMs = state.lastTradeExchangeAt == null
    ? null
    : Math.max(0, Date.now() - state.lastTradeExchangeAt);
  updateStreamHealth();
  renderTrades();
  scheduleRender();
}

function updateCurrentBar(trade) {
  const interval = intervalMilliseconds[state.selection.interval];
  if (!interval) return { updated: false, created: false };
  const result = applyTradeToBars(state.bars, trade, interval);
  if (result.created) {
    if (state.view.rightOffset > 0) state.view.rightOffset += 1;
    state.barSelection = currentSelection();
    renderConnectionSummary();
  }
  return result;
}

function render() {
  state.renderScheduled = false;
  renderMetrics();
  renderVisibleRange();
  renderIndicatorReadouts();
  const visibleWindow = currentVisibleWindow();
  drawPriceChart({
    canvas: elements.priceCanvas,
    allBars: state.bars,
    visibleWindow,
    hover: state.view.hover,
    rightOffset: state.view.rightOffset,
    interval: state.selection.interval,
  });
  for (const id of state.activeIndicatorIds) {
    const pane = indicatorPanes.get(id);
    if (!pane) continue;
    const renderInput = {
      canvas: pane.canvas,
      allBars: state.bars,
      entry: state.indicators.get(id),
      visibleWindow,
      hover: state.view.hover,
      interval: state.selection.interval,
    };
    try {
      drawIndicatorPane(renderInput);
    } catch (error) {
      drawIndicatorPane({
        ...renderInput,
        entry: {
          definition: INDICATOR_REGISTRY.get(id),
          data: null,
          error: error instanceof Error ? error : new Error(String(error)),
        },
      });
    }
  }
}

function scheduleRender() {
  if (state.renderScheduled) return;
  state.renderScheduled = true;
  window.requestAnimationFrame(render);
}

function bindChartCanvas(canvas, source) {
  canvas.addEventListener("pointermove", (event) => handlePointerMove(event, source));
  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointerup", handlePointerUp);
  canvas.addEventListener("pointercancel", handlePointerUp);
  canvas.addEventListener("lostpointercapture", handlePointerUp);
  canvas.addEventListener("pointerleave", handlePointerLeave);
  canvas.addEventListener("wheel", (event) => handleWheel(event, source), { passive: false });
  canvas.addEventListener("dblclick", resetView);
}

function handlePointerMove(event, source) {
  if (state.bars.length === 0) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const padding = source === "price" ? PRICE_PADDING : INDICATOR_PADDING;
  const plotWidth = Math.max(1, rect.width - padding.left - padding.right);
  if (state.view.dragging) {
    const window = currentVisibleWindow();
    const deltaBars = ((event.clientX - state.view.dragStartX) / plotWidth) * window.count;
    const next = panWindow(state.bars.length, state.view.visibleCount, state.view.dragStartOffset, deltaBars);
    state.view.rightOffset = next.rightOffset;
    state.view.hover = null;
    scheduleRender();
    return;
  }
  const window = currentVisibleWindow();
  const absoluteIndex = indexFromPlotX(x, padding.left, plotWidth, window);
  if (absoluteIndex === null) return;
  state.view.hover = { absoluteIndex, source, priceY: source === "price" ? y : null };
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
  if (event.type !== "lostpointercapture") event.currentTarget.releasePointerCapture?.(event.pointerId);
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
  const plotWidth = Math.max(1, elements.priceCanvas.clientWidth - PRICE_PADDING.left - PRICE_PADDING.right);
  const next = zoomWindow(
    state.bars.length,
    state.view.visibleCount,
    state.view.rightOffset,
    pointerRatio,
    scale,
    minimumVisibleBarsForPlotWidth(plotWidth),
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
  cancelDrag();
  scheduleRender();
}

function cancelDrag() {
  state.view.dragging = false;
  document.querySelectorAll(".chart-canvas, .indicator-canvas").forEach((canvas) => canvas.classList.remove("is-dragging"));
}

function currentVisibleWindow() {
  return getVisibleWindow(state.bars.length, state.view.visibleCount, state.view.rightOffset);
}

function renderVisibleRange() {
  const window = currentVisibleWindow();
  elements.visibleRangeLabel.textContent = window.count === 0
    ? "等待数据"
    : `${window.count} 根 · ${window.start + 1}–${window.end} / ${state.bars.length}`;
}

function renderMetrics() {
  const hoverIndex = state.view.hover?.absoluteIndex;
  const isCrosshairReadout = Number.isInteger(hoverIndex) && Boolean(state.bars[hoverIndex]);
  const bar = isCrosshairReadout ? state.bars[hoverIndex] : state.bars.at(-1);
  if (!bar) {
    elements.metricReadMode.textContent = "LIVE · 等待 K 线";
    elements.metricReadMode.classList.remove("crosshair");
    for (const element of [elements.openValue, elements.highValue, elements.lowValue, elements.closeValue, elements.volumeValue, elements.barTimeValue]) {
      element.textContent = "—";
    }
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
}

function renderIndicatorReadouts() {
  const hoverIndex = state.view.hover?.absoluteIndex;
  const metricIndex = Number.isInteger(hoverIndex) && state.bars[hoverIndex]
    ? hoverIndex
    : state.bars.length - 1;
  for (const id of state.activeIndicatorIds) {
    const pane = indicatorPanes.get(id);
    const entry = state.indicators.get(id);
    if (!pane) continue;
    for (const element of pane.readouts.values()) element.textContent = "—";
    pane.root.classList.toggle("has-error", Boolean(entry?.error));
    if (!entry || entry.error || metricIndex < 0) continue;
    for (const [key, element] of pane.readouts) {
      element.textContent = formatIndicator(entry.data[key][metricIndex]);
    }
  }
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
    return `<tr><td>${new Date(trade.time).toLocaleTimeString("zh-CN", { hour12: false })}</td><td class="${sideClass}">${escapeHtml(trade.side)}</td><td>${formatPrice(trade.price)}</td><td>${compactNumber(trade.size)}</td></tr>`;
  }).join("");
}

function startFreshnessTimer() {
  if (state.freshnessTimer) window.clearInterval(state.freshnessTimer);
  state.freshnessTimer = window.setInterval(updateStreamHealth, 1000);
  updateStreamHealth();
}

function startNetworkRouteMonitor() {
  if (state.routeTimer) window.clearInterval(state.routeTimer);
  void refreshNetworkRoute();
  state.routeTimer = window.setInterval(refreshNetworkRoute, NETWORK_ROUTE_REFRESH_MS);
}

async function refreshNetworkRoute() {
  if (state.routeProbeInFlight) return;
  state.routeProbeInFlight = true;
  try {
    const response = await fetch("/api/network-route", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderNetworkRoute(await response.json());
  } catch (error) {
    renderNetworkRoute({
      mode: "unknown",
      status: "unknown",
      detail: `路由诊断接口不可用：${error instanceof Error ? error.message : String(error)}`,
      disclaimer: "行情连接仍会继续尝试。",
    });
  } finally {
    state.routeProbeInFlight = false;
  }
}

function renderNetworkRoute(route) {
  const proxyAddress = route.proxy ? `${route.proxy.host}:${route.proxy.port}` : "";
  let badge = "?";
  let badgeClass = "unknown";
  let text = "UNKNOWN";
  if (route.mode === "system-proxy" && route.status === "ready") {
    badge = "P";
    badgeClass = "proxy";
    text = `SYSTEM · ${proxyAddress}`;
  } else if (route.mode === "system-proxy" && route.status === "unreachable") {
    badge = "!";
    badgeClass = "error";
    text = `PROXY DOWN · ${proxyAddress}`;
  } else if (route.mode === "direct") {
    badge = "D";
    badgeClass = "direct";
    text = "DIRECT · 未配置代理";
  }
  elements.routeBadge.textContent = badge;
  elements.routeBadge.className = `route-badge ${badgeClass}`;
  elements.routeText.textContent = text;
  elements.routeStatus.title = [route.detail, route.disclaimer].filter(Boolean).join(" ");
  state.routeHealth = {
    text,
    detail: [route.detail, route.disclaimer].filter(Boolean).join(" "),
  };
  renderDiagnostics();
}

function updateStreamHealth() {
  const now = Date.now();
  const streamHealth = deriveStreamHealth({
    isOpen: dataSource.isOpen,
    lastTradeReceivedAt: state.lastTradeReceivedAt,
    lastTransportActivityAt: state.lastTransportActivityAt,
    transportDelayMs: state.lastTransportDelayMs,
    now,
  });
  elements.streamBadge.textContent = streamHealth.badge;
  elements.streamBadge.className = `stream-badge ${streamHealth.badgeClass}`;
  elements.lastTradeAge.textContent = streamHealth.detail;
  elements.transportDelay.textContent = state.lastTransportDelayMs == null ? "—" : `约 ${formatAge(state.lastTransportDelayMs)}`;
  elements.historySyncStatus.textContent = historyHealthText(now);
  elements.historySyncStatus.title = state.historyHealth.lastError ?? "";
  renderConnectionSummary();
  renderDiagnostics(streamHealth);
}

function historyHealthText(now = Date.now()) {
  const health = state.historyHealth;
  if (health.status === "loading") {
    return health.attempt > 0 ? `LOADING · 重试 #${health.attempt}` : "LOADING · 首次加载";
  }
  if (health.status === "retry") {
    const remaining = Math.max(0, (health.retryAt ?? now) - now);
    return `RETRY #${health.attempt} · ${formatAge(remaining)}后`;
  }
  if (health.status === "error") return `FAILED · ${shortError(health.lastError)}`;
  if (state.lastHistorySyncAt != null) return `OK · ${formatAge(now - state.lastHistorySyncAt)}前 · ${health.barCount}根`;
  return "等待首次加载";
}

function renderConnectionSummary() {
  const connection = state.connection;
  if (connection.kind !== "connected") {
    setStatus(connection.kind, connection.message);
    return;
  }
  const historyPending = state.historyHealth.status !== "ok" && state.lastHistorySyncAt == null;
  if (historyPending) {
    const retry = state.historyHealth.status === "retry" ? ` · ${historyHealthText()}` : "";
    setStatus("degraded", `实时流正常 · 历史恢复中${retry} · ${state.bars.length} 根`);
    return;
  }
  setStatus("connected", `实时接收中 · ${state.bars.length} 根 K 线`);
}

function renderDiagnostics(streamHealth = deriveStreamHealth({
  isOpen: dataSource.isOpen,
  lastTradeReceivedAt: state.lastTradeReceivedAt,
  lastTransportActivityAt: state.lastTransportActivityAt,
  transportDelayMs: state.lastTransportDelayMs,
})) {
  elements.diagnosticWs.textContent = `${streamHealth.badge} · ${streamHealth.detail}`;
  elements.diagnosticHistory.textContent = historyHealthText();
  elements.diagnosticHistory.title = state.historyHealth.lastError ?? "";
  elements.diagnosticRoute.textContent = state.routeHealth.text;
  elements.diagnosticRoute.title = state.routeHealth.detail;
  elements.diagnosticLastError.textContent = state.historyHealth.lastError ?? "无";
  const hasHistoryProblem = ["retry", "error"].includes(state.historyHealth.status);
  elements.diagnosticSummary.textContent = hasHistoryProblem ? "REST RECOVERING" : streamHealth.badge;
  elements.diagnosticSummary.className = `diagnostic-summary ${hasHistoryProblem ? "warning" : streamHealth.badgeClass}`;
}

function shortError(message) {
  if (!message) return "未知错误";
  return message.length > 28 ? `${message.slice(0, 27)}…` : message;
}

function formatAge(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1000) return "<1s";
  if (milliseconds < 60_000) return `${Math.floor(milliseconds / 1000)}s`;
  return `${Math.floor(milliseconds / 60_000)}m`;
}

function handleVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  void refreshNetworkRoute();
  if (dataSource.isOpen) {
    const lastAttemptAt = state.historyHealth.lastAttemptAt ?? 0;
    if (state.lastHistorySyncAt != null
      && !state.historyLoad
      && Date.now() - lastAttemptAt > VISIBILITY_RECONCILE_MIN_MS) {
      requestHistory({ background: true });
    }
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
  return formatTime(time, state.selection.interval);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

initialize();
