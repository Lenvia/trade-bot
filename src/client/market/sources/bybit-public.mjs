import {
  createCanonicalBar,
  createCanonicalTrade,
  normalizeMarketSelection,
} from "../contract.mjs";
import { historyRetryDelay } from "../health.mjs";

export const BYBIT_REST_URL = "https://api.bybit.com/v5/market/kline";
export const BYBIT_LINEAR_WS_URL = "wss://stream.bybit.com/v5/public/linear";

const INTERVALS = Object.freeze({
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "2h": "120",
  "4h": "240",
  "6h": "360",
  "12h": "720",
  "1D": "D",
});
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 45_000;
const HISTORY_TIMEOUT_MS = 15_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const NOOP = () => {};

export class BybitPublicSource {
  constructor({
    WebSocketImpl = globalThis.WebSocket,
    fetchImpl = globalThis.fetch,
    AbortControllerImpl = globalThis.AbortController,
    scheduler = globalThis,
    now = () => Date.now(),
    random = Math.random,
    restUrl = BYBIT_REST_URL,
    wsUrl = BYBIT_LINEAR_WS_URL,
    callbacks = {},
  } = {}) {
    if (typeof WebSocketImpl !== "function") {
      throw new TypeError("WebSocketImpl must be a constructor");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (typeof AbortControllerImpl !== "function") {
      throw new TypeError("AbortControllerImpl must be a constructor");
    }
    this.WebSocketImpl = WebSocketImpl;
    // Browser fetch requires the Window receiver in some runtimes. Wrapping it
    // also keeps transport injection separate from provider protocol code.
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.AbortControllerImpl = AbortControllerImpl;
    this.scheduler = scheduler;
    this.now = now;
    this.random = random;
    this.restUrl = restUrl;
    this.wsUrl = wsUrl;
    this.callbacks = {
      onConnectionState: callbacks.onConnectionState ?? NOOP,
      onHistoryStart: callbacks.onHistoryStart ?? NOOP,
      onHistory: callbacks.onHistory ?? NOOP,
      onHistoryError: callbacks.onHistoryError ?? NOOP,
      onHistoryRetry: callbacks.onHistoryRetry ?? NOOP,
      onTrades: callbacks.onTrades ?? NOOP,
      onTransportActivity: callbacks.onTransportActivity ?? NOOP,
      onLog: callbacks.onLog ?? NOOP,
    };
    this.socket = null;
    this.selection = null;
    this.subscribedSymbol = null;
    this.historyRequest = null;
    this.historyRetryTimer = null;
    this.historyRetryAttempt = 0;
    this.hasSuccessfulHistory = false;
    this.requestSequence = 0;
    this.shouldReconnect = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastMessageAt = null;
  }

  get isOpen() {
    return this.socket?.readyState === (this.WebSocketImpl.OPEN ?? 1);
  }

  connect(selection) {
    this.selection = normalizeSelection(selection);
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.clearHistoryRetry();
    this.hasSuccessfulHistory = false;
    this.closeCurrentSocket("Manual reconnect");
    this.openConnection();
  }

  disconnect(reason = "Page closed") {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.clearHistoryRetry();
    this.closeCurrentSocket(reason);
    this.callbacks.onConnectionState({ kind: "idle", message: "连接已关闭", canRefresh: false });
  }

  reconnectNow() {
    if (!this.shouldReconnect || this.isOpen) return;
    this.clearReconnectTimer();
    this.openConnection();
  }

  updateSelection(selection) {
    const previousSymbol = this.selection ? bybitSymbol(this.selection.symbol) : null;
    const previousInterval = this.selection?.interval ?? null;
    this.selection = normalizeSelection(selection);
    if (previousSymbol !== bybitSymbol(this.selection.symbol) || previousInterval !== this.selection.interval) {
      this.clearHistoryRetry();
      this.hasSuccessfulHistory = false;
    }
    if (!this.isOpen) return;

    const nextSymbol = bybitSymbol(this.selection.symbol);
    if (previousSymbol !== nextSymbol) {
      if (this.subscribedSymbol) this.sendSubscription("unsubscribe", this.subscribedSymbol);
      this.sendSubscription("subscribe", nextSymbol);
      this.subscribedSymbol = nextSymbol;
    }
    this.requestHistory();
  }

  requestHistory({ background = false, retry = false } = {}) {
    if (!this.isOpen || !this.selection) return null;
    if (background && this.historyRequest) return null;
    if (!retry) this.clearHistoryRetry();
    if (this.historyRequest) {
      this.failHistoryRequest(this.historyRequest, "History request superseded.", "superseded");
    }

    const request = {
      requestId: ++this.requestSequence,
      background,
      selection: { ...this.selection },
      controller: new this.AbortControllerImpl(),
      timeout: null,
      startedAt: this.now(),
      retryAttempt: retry ? this.historyRetryAttempt : 0,
    };
    this.historyRequest = request;
    request.timeout = this.scheduler.setTimeout(() => {
      if (this.historyRequest !== request) return;
      this.failHistoryRequest(request, "History request timed out.", "timeout");
    }, HISTORY_TIMEOUT_MS);

    const publicRequest = publicHistoryRequest(request);
    this.callbacks.onHistoryStart(publicRequest);
    this.callbacks.onLog(
      `${background ? "Background history reconcile" : "History request"}: `
      + `${request.selection.symbol} ${request.selection.interval} rows=${background ? 20 : request.selection.rows}`,
    );
    void this.loadHistory(request);
    return publicRequest;
  }

  async loadHistory(request) {
    const url = historyUrl(this.restUrl, request.selection, request.background ? 20 : request.selection.rows);
    try {
      const response = await this.fetchImpl(url, { signal: request.controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.retCode !== 0) throw new Error(payload.retMsg || `Bybit error ${payload.retCode}`);
      if (this.historyRequest !== request) return;

      const bars = (payload.result?.list ?? [])
        .map(normalizeBybitBar)
        .filter(Boolean)
        .sort((left, right) => left.time - right.time);
      this.clearHistoryTimeout(request);
      this.historyRequest = null;
      this.clearHistoryRetry();
      this.hasSuccessfulHistory = true;
      this.callbacks.onHistory({ request: publicHistoryRequest(request), bars, receivedAt: this.now() });
    } catch (error) {
      if (this.historyRequest !== request) return;
      this.failHistoryRequest(request, error?.message || "Unknown history error", "provider");
    }
  }

  openConnection() {
    const connecting = this.WebSocketImpl.CONNECTING ?? 0;
    if (this.socket && this.socket.readyState <= connecting) return;
    this.callbacks.onConnectionState({ kind: "connecting", message: "正在连接 Bybit…", canRefresh: false });
    this.callbacks.onLog(`Connecting to ${this.wsUrl}`);

    let socket;
    try {
      socket = new this.WebSocketImpl(this.wsUrl);
    } catch (error) {
      this.callbacks.onConnectionState({ kind: "error", message: "连接创建失败", canRefresh: false });
      this.callbacks.onLog(`WebSocket constructor failed: ${error.message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.lastMessageAt = this.now();
      this.emitTransportActivity("open");
      const symbol = bybitSymbol(this.selection.symbol);
      this.sendSubscription("subscribe", symbol);
      this.subscribedSymbol = symbol;
      this.startHeartbeat(socket);
      this.callbacks.onConnectionState({
        kind: "connected",
        message: "已连接 Bybit Public",
        canRefresh: true,
      });
      this.requestHistory();
    });
    socket.addEventListener("message", ({ data }) => {
      if (this.socket === socket) this.handleMessage(data);
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.callbacks.onConnectionState({ kind: "error", message: "连接错误", canRefresh: false });
      this.callbacks.onLog("Bybit WebSocket error. Check proxy and browser console.");
    });
    socket.addEventListener("close", ({ code, reason }) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.subscribedSymbol = null;
      this.clearHeartbeat();
      this.clearHistoryRetry();
      if (this.historyRequest) {
        this.failHistoryRequest(this.historyRequest, "Connection closed during history request.", "disconnect");
      }
      this.callbacks.onLog(`Connection closed: code=${code}${reason ? ` reason=${reason}` : ""}`);
      if (this.shouldReconnect) this.scheduleReconnect();
      else this.callbacks.onConnectionState({ kind: "idle", message: "连接已关闭", canRefresh: false });
    });
  }

  closeCurrentSocket(reason) {
    const socket = this.socket;
    this.socket = null;
    this.subscribedSymbol = null;
    this.clearHeartbeat();
    this.clearHistoryRetry();
    if (this.historyRequest) {
      this.failHistoryRequest(this.historyRequest, "History request cancelled.", "disconnect");
    }
    const closing = this.WebSocketImpl.CLOSING ?? 2;
    if (socket && socket.readyState < closing) socket.close(1000, reason);
  }

  scheduleReconnect() {
    if (this.reconnectTimer || !this.shouldReconnect) return;
    const delay = Math.min(1000 * (2 ** this.reconnectAttempt), RECONNECT_MAX_DELAY_MS);
    this.reconnectAttempt += 1;
    this.callbacks.onConnectionState({
      kind: "connecting",
      message: `连接中断，${Math.ceil(delay / 1000)} 秒后重连`,
      canRefresh: false,
    });
    this.callbacks.onLog(`Reconnect scheduled in ${delay}ms.`);
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      this.openConnection();
    }, delay);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer !== null) this.scheduler.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  startHeartbeat(socket) {
    this.clearHeartbeat();
    this.lastMessageAt = this.now();
    this.pingTimer = this.scheduler.setInterval(() => {
      if (this.socket !== socket || !this.isOpen) return;
      if (this.now() - this.lastMessageAt > PONG_TIMEOUT_MS) {
        this.callbacks.onLog("Heartbeat timed out; reconnecting.");
        socket.close(4000, "Heartbeat timeout");
        return;
      }
      socket.send(JSON.stringify({ req_id: `ping-${this.now()}`, op: "ping" }));
    }, PING_INTERVAL_MS);
  }

  clearHeartbeat() {
    if (this.pingTimer !== null) this.scheduler.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.lastMessageAt = null;
  }

  handleMessage(data) {
    if (typeof data !== "string") return;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      this.callbacks.onLog(`Unparsed message: ${data.slice(0, 180)}`);
      return;
    }
    this.lastMessageAt = this.now();
    this.emitTransportActivity(message.op === "pong" || message.ret_msg === "pong" ? "pong" : "message");

    if (message.op === "subscribe") {
      if (message.success === false) {
        this.callbacks.onConnectionState({ kind: "error", message: "订阅失败", canRefresh: true });
        this.callbacks.onLog(`Subscription failed: ${message.ret_msg || "Unknown error"}`);
        return;
      }
      this.reconnectAttempt = 0;
      this.callbacks.onLog(`Subscribed: ${this.subscribedSymbol}`);
      return;
    }
    if (message.op === "pong" || message.ret_msg === "pong") return;

    const selectedSymbol = this.selection ? bybitSymbol(this.selection.symbol) : null;
    if (message.topic !== `publicTrade.${selectedSymbol}`) return;
    const trades = normalizeBybitTrades(message.data);
    if (trades.length > 0) this.callbacks.onTrades(trades);
  }

  failHistoryRequest(request, message, reason) {
    if (this.historyRequest !== request) return;
    request.controller.abort();
    this.clearHistoryTimeout(request);
    this.historyRequest = null;
    this.callbacks.onHistoryError({ request: publicHistoryRequest(request), message, reason });
    this.callbacks.onLog(`${request.background ? "Background history" : "History request"} failed: ${message}`);
    if (this.shouldRetryHistory(request, reason)) this.scheduleHistoryRetry(message);
  }

  shouldRetryHistory(request, reason) {
    if (!this.shouldReconnect || !this.isOpen) return false;
    if (reason === "superseded" || reason === "disconnect") return false;
    return !request.background || !this.hasSuccessfulHistory;
  }

  scheduleHistoryRetry(message) {
    if (this.historyRetryTimer !== null || !this.shouldReconnect || !this.isOpen) return;
    this.historyRetryAttempt += 1;
    const delay = historyRetryDelay(this.historyRetryAttempt, this.random);
    const retryAt = this.now() + delay;
    this.callbacks.onHistoryRetry({
      attempt: this.historyRetryAttempt,
      delay,
      retryAt,
      message,
      selection: { ...this.selection },
    });
    this.callbacks.onLog(`History retry #${this.historyRetryAttempt} scheduled in ${delay}ms.`);
    this.historyRetryTimer = this.scheduler.setTimeout(() => {
      this.historyRetryTimer = null;
      if (this.shouldReconnect && this.isOpen) this.requestHistory({ retry: true });
    }, delay);
  }

  clearHistoryRetry({ resetAttempt = true } = {}) {
    if (this.historyRetryTimer !== null) this.scheduler.clearTimeout(this.historyRetryTimer);
    this.historyRetryTimer = null;
    if (resetAttempt) this.historyRetryAttempt = 0;
  }

  clearHistoryTimeout(request) {
    if (request.timeout !== null) this.scheduler.clearTimeout(request.timeout);
    request.timeout = null;
  }

  emitTransportActivity(kind) {
    this.callbacks.onTransportActivity({ kind, receivedAt: this.now() });
  }

  sendSubscription(op, symbol) {
    if (!this.isOpen) return;
    this.socket.send(JSON.stringify({ op, args: [`publicTrade.${symbol}`] }));
  }
}

export function bybitInterval(interval) {
  const mapped = INTERVALS[interval];
  if (!mapped) throw new RangeError(`Unsupported Bybit interval: ${interval}`);
  return mapped;
}

export function bybitSymbol(productId) {
  const symbol = String(productId ?? "").split(":").at(-1)?.toUpperCase() ?? "";
  if (!/^[A-Z0-9-]{2,40}$/.test(symbol)) {
    throw new RangeError(`Unsupported Bybit symbol: ${productId}`);
  }
  return symbol;
}

export function normalizeBybitBar(bar) {
  if (!Array.isArray(bar) || bar.length < 6) return null;
  return createCanonicalBar({
    time: Number(bar[0]),
    open: Number(bar[1]),
    high: Number(bar[2]),
    low: Number(bar[3]),
    close: Number(bar[4]),
    volume: Number(bar[5]),
  });
}

export function normalizeBybitTrades(trades) {
  if (!Array.isArray(trades)) return [];
  return trades.map((trade) => {
    return createCanonicalTrade({
      id: trade?.i ?? null,
      time: Number(trade?.T),
      price: Number(trade?.p),
      size: Number(trade?.v ?? 0),
      side: String(trade?.S ?? "Unknown"),
    });
  }).filter(Boolean);
}

function historyUrl(baseUrl, selection, rows) {
  const url = new URL(baseUrl);
  url.search = new URLSearchParams({
    category: "linear",
    symbol: bybitSymbol(selection.symbol),
    interval: bybitInterval(selection.interval),
    limit: String(Math.min(rows, 1000)),
  });
  return url.toString();
}

function normalizeSelection(selection) {
  const normalized = normalizeMarketSelection(selection, {
    supportedIntervals: Object.keys(INTERVALS),
    maxRows: 1000,
  });
  bybitSymbol(normalized.symbol);
  bybitInterval(normalized.interval);
  return normalized;
}

function publicHistoryRequest(request) {
  return {
    requestId: request.requestId,
    background: request.background,
    selection: { ...request.selection },
    startedAt: request.startedAt,
    retryAttempt: request.retryAttempt,
  };
}
