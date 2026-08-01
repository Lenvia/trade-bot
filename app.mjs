import { macd, rsi, splitThresholdSegments } from "/indicators.mjs";
import { applyTradeToBars, mergeHistoryWithLive } from "/live-data.mjs";
import {
  DEFAULT_VISIBLE_BARS,
  clamp,
  getVisibleWindow,
  indexFromPlotX,
  minimumVisibleBarsForPlotWidth,
  panWindow,
  zoomWindow,
} from "/chart-view.mjs";

const WS_URL = "wss://gocharting.com/sdk/ws";
const MAX_TRADES = 40;
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const STREAM_DELAYED_AFTER_MS = 5_000;
const STREAM_STALE_AFTER_MS = 15_000;
const PRICE_PADDING = { top: 24, right: 78, bottom: 34, left: 12 };
const INDICATOR_PADDING = { left: 12, right: 78, top: 8, bottom: 22 };
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
  socket: null,
  bars: [],
  historyRequest: null,
  trades: [],
  pingTimer: null,
  reconcileTimer: null,
  reconnectTimer: null,
  freshnessTimer: null,
  shouldReconnect: false,
  reconnectAttempt: 0,
  lastTradeReceivedAt: null,
  lastTradeExchangeAt: null,
  lastTransportDelayMs: null,
  lastHistorySyncAt: null,
  renderScheduled: false,
  subscribedSymbol: null,
  view: {
    visibleCount: DEFAULT_VISIBLE_BARS,
    rightOffset: 0,
    hover: null,
    dragging: false,
    dragStartX: 0,
    dragStartOffset: 0,
  },
};

elements.connectButton.addEventListener("click", () => connect());
elements.refreshButton.addEventListener("click", () => requestHistory());
elements.symbolSelect.addEventListener("change", changeSubscription);
elements.intervalSelect.addEventListener("change", () => requestHistory());
elements.rowsSelect.addEventListener("change", () => requestHistory());
window.addEventListener("resize", scheduleRender);
window.addEventListener("beforeunload", disconnect);
document.addEventListener("visibilitychange", handleVisibilityChange);
setupChartInteractions();
startFreshnessTimer();

function connect() {
  state.shouldReconnect = true;
  state.reconnectAttempt = 0;
  clearReconnectTimer();
  closeCurrentSocket("Manual reconnect");
  openConnection();
}

function openConnection() {
  if (state.socket && state.socket.readyState < WebSocket.CLOSING) return;
  setStatus("connecting", "正在连接…");
  log(`Connecting to ${WS_URL}`);
  const socket = new WebSocket(WS_URL);
  state.socket = socket;

  socket.addEventListener("open", () => {
    if (state.socket !== socket) return;
    state.reconnectAttempt = 0;
    log("WebSocket transport opened; waiting for welcome frame.");
    socket.send("PING");
    requestHistory();
    subscribe(elements.symbolSelect.value);
    clearPingTimer();
    state.pingTimer = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send("PING");
    }, 20_000);
    startReconcileTimer();
    updateStreamHealth();
  });

  socket.addEventListener("message", ({ data }) => {
    if (state.socket === socket) handleMessage(data);
  });
  socket.addEventListener("error", () => {
    if (state.socket !== socket) return;
    setStatus("error", "连接错误");
    log("WebSocket error. Check network access and browser console.");
  });
  socket.addEventListener("close", ({ code, reason }) => {
    if (state.socket !== socket) return;
    state.socket = null;
    state.subscribedSymbol = null;
    state.historyRequest = null;
    elements.refreshButton.disabled = true;
    log(`Connection closed: code=${code}${reason ? ` reason=${reason}` : ""}`);
    clearPingTimer();
    clearReconcileTimer();
    updateStreamHealth();
    if (state.shouldReconnect) scheduleReconnect();
    else setStatus("idle", "连接已关闭");
  });
}

function disconnect() {
  state.shouldReconnect = false;
  clearReconnectTimer();
  clearPingTimer();
  clearReconcileTimer();
  closeCurrentSocket("Page closed");
  updateStreamHealth();
}

function closeCurrentSocket(reason) {
  const socket = state.socket;
  state.socket = null;
  state.subscribedSymbol = null;
  state.historyRequest = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, reason);
}

function scheduleReconnect() {
  if (state.reconnectTimer || !state.shouldReconnect) return;
  const delay = Math.min(1000 * (2 ** state.reconnectAttempt), 30_000);
  state.reconnectAttempt += 1;
  setStatus("connecting", `连接中断，${Math.ceil(delay / 1000)} 秒后重连`);
  log(`Reconnect scheduled in ${delay}ms.`);
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    openConnection();
  }, delay);
}

function clearReconnectTimer() {
  if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

function clearPingTimer() {
  if (state.pingTimer) window.clearInterval(state.pingTimer);
  state.pingTimer = null;
}

function startReconcileTimer() {
  clearReconcileTimer();
  state.reconcileTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") requestHistory({ background: true });
  }, RECONCILE_INTERVAL_MS);
}

function clearReconcileTimer() {
  if (state.reconcileTimer) window.clearInterval(state.reconcileTimer);
  state.reconcileTimer = null;
}

function handleMessage(data) {
  if (typeof data !== "string") return;
  if (data.startsWith("Welcome-")) {
    setStatus("connected", "已连接 GoCharting Demo");
    elements.refreshButton.disabled = false;
    log(data);
    return;
  }
  if (data.startsWith("PONG")) return;

  let message;
  try {
    message = JSON.parse(data);
  } catch {
    log(`Unparsed message: ${data.slice(0, 180)}`);
    return;
  }

  if (message.command === "ERROR") {
    const detail = message.message ?? message.out?.message ?? "Unknown API error";
    const isBackgroundHistoryError = state.historyRequest?.background
      && (message.request_id == null || message.request_id === state.historyRequest.requestId);
    if (isBackgroundHistoryError) {
      log(`Background history reconcile skipped: ${detail}`);
      state.historyRequest = null;
      updateStreamHealth();
      return;
    }
    setStatus("error", "接口返回错误");
    log(`ERROR: ${detail}`);
    return;
  }

  if (message.command === "timeseries") {
    receiveHistoryChunk(message);
    return;
  }

  if (message.command === "SUBSCRIBE") {
    log(`Subscribed: ${(message.payload ?? []).join(", ")}`);
    return;
  }

  if (message.channel === "trade") receiveTrades(message.payload ?? {});
}

function requestHistory({ background = false } = {}) {
  if (!isSocketOpen()) return;
  if (background && state.historyRequest) return;

  if (!background) {
    state.bars = [];
    state.trades = [];
    state.view.hover = null;
    state.view.rightOffset = 0;
    renderTrades();
    scheduleRender();
  }

  const requestId = Date.now();
  const rows = background ? 20 : Number(elements.rowsSelect.value);
  state.historyRequest = { requestId, background, buffer: [] };
  const payload = {
    request_id: requestId,
    command: "timeseries",
    payload: {
      symbol: elements.symbolSelect.value,
      interval: elements.intervalSelect.value,
      session: "RTH",
      hint: `rows=${rows}`,
      echo: background ? "codex-background-reconcile" : "codex-learning-demo",
    },
  };
  state.socket.send(JSON.stringify(payload));
  if (!background) setStatus("connecting", "正在读取历史 K 线…");
  log(`${background ? "Background history reconcile" : "History request"}: ${payload.payload.symbol} ${payload.payload.interval} ${payload.payload.hint}`);
}

function receiveHistoryChunk(message) {
  const request = state.historyRequest;
  if (!request || (message.request_id != null && message.request_id !== request.requestId)) return;
  const rawBars = flattenBars(message.payload?.bars);
  request.buffer.push(...rawBars.map(normalizeBar).filter(Boolean));

  if (![1, 2].includes(message.final)) return;
  const unique = new Map(request.buffer.map((bar) => [bar.time, bar]));
  const receivedBars = [...unique.values()].sort((a, b) => a.time - b.time);

  if (request.background) {
    state.bars = mergeHistoryWithLive(receivedBars, state.bars);
    log(`Background history reconcile complete: ${receivedBars.length} bars checked.`);
  } else {
    state.bars = receivedBars;
    resetView();
    log(`History complete: ${state.bars.length} normalized bars.`);
  }

  state.historyRequest = null;
  state.lastHistorySyncAt = Date.now();
  setStatus("connected", `实时接收中 · ${state.bars.length} 根 K 线`);
  elements.emptyState.hidden = state.bars.length > 0;
  updateStreamHealth();
  scheduleRender();
}

function flattenBars(rawBars) {
  if (Array.isArray(rawBars)) return rawBars;
  if (!rawBars || typeof rawBars !== "object") return [];
  return Object.values(rawBars).flatMap((group) => (Array.isArray(group) ? group : []));
}

function normalizeBar(bar) {
  const time = new Date(bar.date ?? bar.time ?? bar.timestamp).getTime();
  const normalized = {
    time,
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    volume: Number(bar.volume ?? 0),
  };
  return Object.values(normalized).every(Number.isFinite) ? normalized : null;
}

function changeSubscription() {
  if (!isSocketOpen()) return;
  if (state.subscribedSymbol) {
    state.socket.send(JSON.stringify({
      command: "UNSUBSCRIBE",
      channel: "trade",
      payload: [state.subscribedSymbol],
    }));
  }
  state.trades = [];
  state.lastTradeReceivedAt = null;
  state.lastTradeExchangeAt = null;
  state.lastTransportDelayMs = null;
  renderTrades();
  subscribe(elements.symbolSelect.value);
  requestHistory();
}

function subscribe(symbol) {
  if (!isSocketOpen()) return;
  state.socket.send(JSON.stringify({
    command: "SUBSCRIBE",
    channel: "trade",
    payload: [symbol],
  }));
  state.subscribedSymbol = symbol;
}

function receiveTrades(payload) {
  const symbol = elements.symbolSelect.value;
  const incoming = Array.isArray(payload[symbol]) ? payload[symbol] : [];
  if (incoming.length === 0) return;

  for (const trade of incoming) {
    const normalized = {
      time: Number(trade.t_ms ?? Date.now()),
      price: Number(trade.ltp),
      size: Number(trade.l_sz ?? 0),
      side: String(trade.side ?? "Unknown"),
    };
    if (![normalized.time, normalized.price, normalized.size].every(Number.isFinite)) continue;
    state.trades.unshift(normalized);
    state.lastTradeReceivedAt = Date.now();
    state.lastTradeExchangeAt = Math.max(state.lastTradeExchangeAt ?? 0, normalized.time);
    updateCurrentBar(normalized);
  }
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
  if (!interval || state.bars.length === 0) return;
  const result = applyTradeToBars(state.bars, trade, interval);
  if (result.created) {
    if (state.view.rightOffset > 0) state.view.rightOffset += 1;
    setStatus("connected", `实时接收中 · ${state.bars.length} 根 K 线`);
  }
}

function render() {
  state.renderScheduled = false;
  renderMetrics();
  renderVisibleRange();
  drawPriceChart();
  drawIndicatorChart();
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

  elements.zoomInButton.addEventListener("click", () => zoomAt(0.5, 0.78));
  elements.zoomOutButton.addEventListener("click", () => zoomAt(0.5, 1.28));
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
  if (!bar) return;

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

  const closes = state.bars.map(({ close }) => close);
  const rsiValues = rsi(closes, 14);
  const macdValues = macd(closes);
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
    const isBuy = trade.side.toLowerCase() === "buy";
    return `<tr>
      <td>${new Date(trade.time).toLocaleTimeString("zh-CN", { hour12: false })}</td>
      <td class="${isBuy ? "buy" : "sell"}">${escapeHtml(trade.side)}</td>
      <td>${formatPrice(trade.price)}</td>
      <td>${compactNumber(trade.size)}</td>
    </tr>`;
  }).join("");
}

function drawPriceChart() {
  const window = currentVisibleWindow();
  const bars = state.bars.slice(window.start, window.end);
  const canvas = elements.priceCanvas;
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
  const yPrice = (value) => padding.top + ((maxPrice - value) / priceRange) * (priceBottom - padding.top);

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
    context.fillRect(x - candleWidth / 2, volumeTop, candleWidth, height - padding.bottom - volumeTop);
    context.globalAlpha = 1;
  });

  context.fillStyle = "rgba(141,153,166,0.72)";
  context.font = "9px ui-monospace, monospace";
  context.fillText("VOLUME", padding.left + 4, height - padding.bottom - volumeHeight + 12);

  drawLastPriceLine(context, width, padding, minPrice, maxPrice, yPrice);
  drawPriceCrosshair(context, {
    bars,
    window,
    width,
    height,
    padding,
    priceBottom,
    plotWidth,
    slot,
    minPrice,
    maxPrice,
    yPrice,
  });

  context.fillStyle = "#8d99a6";
  context.font = "11px ui-monospace, monospace";
  context.fillText(new Date(bars[0].time).toLocaleDateString("zh-CN"), padding.left, height - 8);
  const lastLabel = new Date(bars.at(-1).time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const labelWidth = context.measureText(lastLabel).width;
  context.fillText(lastLabel, width - padding.right - labelWidth, height - 8);
}

function drawLastPriceLine(context, width, padding, minPrice, maxPrice, yPrice) {
  if (state.view.rightOffset !== 0) return;
  const last = state.bars.at(-1);
  if (!last || last.close < minPrice || last.close > maxPrice) return;
  const y = yPrice(last.close);
  const color = last.close >= last.open ? "#62e6a7" : "#ff5e73";
  context.save();
  context.strokeStyle = color;
  context.globalAlpha = 0.65;
  context.setLineDash([3, 3]);
  context.beginPath();
  context.moveTo(padding.left, y);
  context.lineTo(width - padding.right, y);
  context.stroke();
  context.restore();
  drawAxisLabel(context, formatPrice(last.close), width - padding.right + 2, y, color, width);
}

function drawPriceCrosshair(context, geometry) {
  const hover = state.view.hover;
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
  context.fillRect(x - geometry.slot / 2, geometry.padding.top, geometry.slot, geometry.height - geometry.padding.bottom - geometry.padding.top);
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
  drawTimeLabel(context, formatCrosshairTime(bar.time), x, geometry.height - geometry.padding.bottom + 3, geometry.width);
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

function drawIndicatorChart() {
  const canvas = elements.indicatorCanvas;
  const { context, width, height } = prepareCanvas(canvas);
  context.clearRect(0, 0, width, height);
  if (state.bars.length === 0) return;

  const window = currentVisibleWindow();
  const bars = state.bars.slice(window.start, window.end);
  const allCloses = state.bars.map(({ close }) => close);
  const allRsi = rsi(allCloses, 14);
  const allMacd = macd(allCloses);
  const rsiValues = allRsi.slice(window.start, window.end);
  const line = allMacd.line.slice(window.start, window.end);
  const signal = allMacd.signal.slice(window.start, window.end);
  const histogram = allMacd.histogram.slice(window.start, window.end);
  const padding = INDICATOR_PADDING;
  const plotWidth = width - padding.left - padding.right;
  const slot = plotWidth / Math.max(1, bars.length);
  const x = (index) => padding.left + slot * index + slot / 2;

  // MACD 使用上方约 43%，RSI 使用下方约 47%，中间保留标题和分隔带。
  // RSI 始终按 0–100 完整尺度绘制，避免把 30–70 中性区压成容易误判的窄条。
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
  context.beginPath(); context.moveTo(padding.left, macdCenter); context.lineTo(width - padding.right, macdCenter); context.stroke();

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
    context.beginPath(); context.moveTo(padding.left, rsiY(level)); context.lineTo(width - padding.right, rsiY(level)); context.stroke();
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
  if (Number.isFinite(latestRsi)) {
    drawRsiMarker(context, latestRsi, rsiY(latestRsi), width, padding);
  }

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
    window,
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
  const colors = {
    overbought: "#ff5e73",
    neutral: "#c7ff3d",
    oversold: "#53d8fb",
  };
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
  const hover = state.view.hover;
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

  const rsiValue = geometry.rsiValues[localIndex];
  const macdValue = geometry.line[localIndex];
  const signalValue = geometry.signal[localIndex];
  const histogramValue = geometry.histogram[localIndex];
  const text = [
    `MACD ${formatIndicator(macdValue)}`,
    `Signal ${formatIndicator(signalValue)}`,
    `Hist ${formatIndicator(histogramValue)}`,
    `RSI ${formatIndicator(rsiValue)}`,
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
    formatCrosshairTime(geometry.bars[localIndex].time),
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
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    if (!started) { context.moveTo(x(index), y(value)); started = true; }
    else context.lineTo(x(index), y(value));
  });
  if (started) context.stroke();
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

function startFreshnessTimer() {
  if (state.freshnessTimer) window.clearInterval(state.freshnessTimer);
  state.freshnessTimer = window.setInterval(updateStreamHealth, 1000);
  updateStreamHealth();
}

function updateStreamHealth() {
  const now = Date.now();
  const isOpen = isSocketOpen();
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
  if (document.visibilityState !== "visible" || !state.shouldReconnect) return;
  if (isSocketOpen()) {
    const sinceSync = Date.now() - (state.lastHistorySyncAt ?? 0);
    if (sinceSync > 15_000) requestHistory({ background: true });
    return;
  }
  if (!state.reconnectTimer) openConnection();
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

function isSocketOpen() {
  return state.socket?.readyState === WebSocket.OPEN;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: value >= 100 ? 2 : 6 }).format(value);
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 3 }).format(value);
}

function formatIndicator(value) {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(Math.abs(value) >= 100 ? 2 : 4);
}

function formatCrosshairTime(time) {
  const options = elements.intervalSelect.value === "1D"
    ? { year: "numeric", month: "2-digit", day: "2-digit" }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" };
  return new Date(time).toLocaleString("zh-CN", options);
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
