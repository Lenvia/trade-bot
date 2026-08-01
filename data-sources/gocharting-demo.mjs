export const GOCHARTING_DEMO_URL = "wss://gocharting.com/sdk/ws";
export const GOCHARTING_DEMO_SYMBOLS = Object.freeze([
  "BYBIT:FUTURE:BTCUSDT",
  "BYBIT:FUTURE:ETHUSDT",
]);

const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 45_000;
const HISTORY_TIMEOUT_MS = 15_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const NOOP = () => {};

export class GoChartingDemoSource {
  constructor({
    WebSocketImpl = globalThis.WebSocket,
    scheduler = globalThis,
    now = () => Date.now(),
    url = GOCHARTING_DEMO_URL,
    callbacks = {},
  } = {}) {
    if (typeof WebSocketImpl !== "function") {
      throw new TypeError("WebSocketImpl must be a constructor");
    }
    this.WebSocketImpl = WebSocketImpl;
    this.scheduler = scheduler;
    this.now = now;
    this.url = url;
    this.callbacks = {
      onConnectionState: callbacks.onConnectionState ?? NOOP,
      onHistoryStart: callbacks.onHistoryStart ?? NOOP,
      onHistory: callbacks.onHistory ?? NOOP,
      onHistoryError: callbacks.onHistoryError ?? NOOP,
      onTrades: callbacks.onTrades ?? NOOP,
      onLog: callbacks.onLog ?? NOOP,
    };
    this.socket = null;
    this.selection = null;
    this.subscribedSymbol = null;
    this.historyRequest = null;
    this.requestSequence = 0;
    this.shouldReconnect = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastPongAt = null;
  }

  get isOpen() {
    return this.socket?.readyState === (this.WebSocketImpl.OPEN ?? 1);
  }

  connect(selection) {
    this.selection = normalizeSelection(selection);
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.closeCurrentSocket("Manual reconnect");
    this.openConnection();
  }

  disconnect(reason = "Page closed") {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.closeCurrentSocket(reason);
    this.callbacks.onConnectionState({ kind: "idle", message: "连接已关闭", canRefresh: false });
  }

  reconnectNow() {
    if (!this.shouldReconnect || this.isOpen) return;
    this.clearReconnectTimer();
    this.openConnection();
  }

  updateSelection(selection) {
    const previous = this.selection;
    this.selection = normalizeSelection(selection);
    if (!this.isOpen) return;

    if (previous?.symbol !== this.selection.symbol) {
      if (this.subscribedSymbol) this.sendSubscription("UNSUBSCRIBE", this.subscribedSymbol);
      this.sendSubscription("SUBSCRIBE", this.selection.symbol);
      this.subscribedSymbol = this.selection.symbol;
    }
    this.requestHistory();
  }

  requestHistory({ background = false } = {}) {
    if (!this.isOpen || !this.selection) return null;
    if (background && this.historyRequest) return null;
    if (this.historyRequest) {
      this.failHistoryRequest(this.historyRequest, "History request superseded.", "superseded");
    }

    const request = {
      requestId: ++this.requestSequence,
      background,
      selection: { ...this.selection },
      buffer: [],
      timeout: null,
      startedAt: this.now(),
    };
    this.historyRequest = request;
    request.timeout = this.scheduler.setTimeout(() => {
      if (this.historyRequest !== request) return;
      this.failHistoryRequest(request, "History request timed out.", "timeout");
    }, HISTORY_TIMEOUT_MS);

    const publicRequest = publicHistoryRequest(request);
    this.callbacks.onHistoryStart(publicRequest);
    this.socket.send(JSON.stringify({
      request_id: request.requestId,
      command: "timeseries",
      payload: {
        symbol: request.selection.symbol,
        interval: request.selection.interval,
        session: "RTH",
        hint: `rows=${background ? 20 : request.selection.rows}`,
        echo: `trade-bot:${request.requestId}`,
      },
    }));
    this.callbacks.onLog(
      `${background ? "Background history reconcile" : "History request"}: `
      + `${request.selection.symbol} ${request.selection.interval} rows=${background ? 20 : request.selection.rows}`,
    );
    return publicRequest;
  }

  openConnection() {
    const connecting = this.WebSocketImpl.CONNECTING ?? 0;
    if (this.socket && this.socket.readyState <= connecting) return;
    this.callbacks.onConnectionState({ kind: "connecting", message: "正在连接…", canRefresh: false });
    this.callbacks.onLog(`Connecting to ${this.url}`);

    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this.callbacks.onConnectionState({ kind: "error", message: "连接创建失败", canRefresh: false });
      this.callbacks.onLog(`WebSocket constructor failed: ${error.message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.callbacks.onLog("WebSocket transport opened; waiting for welcome frame.");
      this.lastPongAt = this.now();
      socket.send("PING");
      this.requestHistory();
      this.sendSubscription("SUBSCRIBE", this.selection.symbol);
      this.subscribedSymbol = this.selection.symbol;
      this.startHeartbeat(socket);
    });
    socket.addEventListener("message", ({ data }) => {
      if (this.socket === socket) this.handleMessage(data);
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.callbacks.onConnectionState({ kind: "error", message: "连接错误", canRefresh: false });
      this.callbacks.onLog("WebSocket error. Check network access and browser console.");
    });
    socket.addEventListener("close", ({ code, reason }) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.subscribedSymbol = null;
      this.clearHeartbeat();
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
    this.lastPongAt = this.now();
    this.pingTimer = this.scheduler.setInterval(() => {
      if (this.socket !== socket || !this.isOpen) return;
      if (this.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        this.callbacks.onLog("Heartbeat timed out; reconnecting.");
        socket.close(4000, "Heartbeat timeout");
        return;
      }
      socket.send("PING");
    }, PING_INTERVAL_MS);
  }

  clearHeartbeat() {
    if (this.pingTimer !== null) this.scheduler.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.lastPongAt = null;
  }

  handleMessage(data) {
    if (typeof data !== "string") return;
    if (data.startsWith("Welcome-")) {
      this.reconnectAttempt = 0;
      this.callbacks.onConnectionState({
        kind: "connected",
        message: "已连接 GoCharting Demo",
        canRefresh: true,
      });
      this.callbacks.onLog(data);
      return;
    }
    if (data.startsWith("PONG")) {
      this.lastPongAt = this.now();
      return;
    }

    let message;
    try {
      message = JSON.parse(data);
    } catch {
      this.callbacks.onLog(`Unparsed message: ${data.slice(0, 180)}`);
      return;
    }

    if (message.command === "ERROR") {
      this.handleErrorMessage(message);
      return;
    }
    if (message.command === "timeseries") {
      this.receiveHistoryChunk(message);
      return;
    }
    if (message.command === "SUBSCRIBE") {
      this.callbacks.onLog(`Subscribed: ${(message.payload ?? []).join(", ")}`);
      return;
    }
    if (message.channel === "trade") {
      const trades = normalizeTrades(message.payload, this.selection?.symbol);
      if (trades.length > 0) this.callbacks.onTrades(trades);
    }
  }

  handleErrorMessage(message) {
    const detail = message.message ?? message.out?.message ?? "Unknown API error";
    const request = this.historyRequest;
    if (request && message.request_id === request.requestId) {
      this.failHistoryRequest(request, detail, "provider");
      return;
    }
    this.callbacks.onConnectionState({ kind: "error", message: "接口返回错误", canRefresh: this.isOpen });
    this.callbacks.onLog(`ERROR: ${detail}`);
  }

  receiveHistoryChunk(message) {
    const request = this.historyRequest;
    if (!request || (message.request_id != null && message.request_id !== request.requestId)) return;
    const criteria = message.payload?.criteria;
    if (criteria?.symbol && criteria.symbol !== request.selection.symbol) return;
    if (criteria?.interval && criteria.interval !== request.selection.interval) return;

    request.buffer.push(...flattenBars(message.payload?.bars).map(normalizeBar).filter(Boolean));
    if (![1, 2].includes(message.final)) return;

    const unique = new Map(request.buffer.map((bar) => [bar.time, bar]));
    const bars = [...unique.values()].sort((left, right) => left.time - right.time);
    this.clearHistoryTimeout(request);
    this.historyRequest = null;
    this.callbacks.onHistory({ request: publicHistoryRequest(request), bars, receivedAt: this.now() });
  }

  failHistoryRequest(request, message, reason) {
    if (this.historyRequest !== request) return;
    this.clearHistoryTimeout(request);
    this.historyRequest = null;
    this.callbacks.onHistoryError({ request: publicHistoryRequest(request), message, reason });
    this.callbacks.onLog(`${request.background ? "Background history" : "History request"} failed: ${message}`);
  }

  clearHistoryTimeout(request) {
    if (request.timeout !== null) this.scheduler.clearTimeout(request.timeout);
    request.timeout = null;
  }

  sendSubscription(command, symbol) {
    if (!this.isOpen) return;
    this.socket.send(JSON.stringify({ command, channel: "trade", payload: [symbol] }));
  }
}

export function flattenBars(rawBars) {
  if (Array.isArray(rawBars)) return rawBars;
  if (!rawBars || typeof rawBars !== "object") return [];
  return Object.values(rawBars).flatMap((group) => (Array.isArray(group) ? group : []));
}

export function normalizeBar(bar) {
  if (!bar || typeof bar !== "object") return null;
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

export function normalizeTrades(payload, symbol) {
  if (!symbol || !payload || typeof payload !== "object") return [];
  const incoming = Array.isArray(payload[symbol]) ? payload[symbol] : [];
  return incoming.map((trade) => {
    const normalized = {
      id: trade.id ?? trade.trade_id ?? trade.tid ?? null,
      time: Number(trade.t_ms),
      price: Number(trade.ltp),
      size: Number(trade.l_sz ?? 0),
      side: String(trade.side ?? "Unknown"),
    };
    return [normalized.time, normalized.price, normalized.size].every(Number.isFinite)
      ? normalized
      : null;
  }).filter(Boolean);
}

function normalizeSelection(selection) {
  const normalized = {
    symbol: String(selection?.symbol ?? ""),
    interval: String(selection?.interval ?? ""),
    rows: Number(selection?.rows),
  };
  if (!GOCHARTING_DEMO_SYMBOLS.includes(normalized.symbol)) {
    throw new RangeError(`Unsupported GoCharting demo symbol: ${normalized.symbol}`);
  }
  if (!normalized.interval || !Number.isInteger(normalized.rows) || normalized.rows <= 0) {
    throw new TypeError("selection requires interval and a positive rows value");
  }
  return normalized;
}

function publicHistoryRequest(request) {
  return {
    requestId: request.requestId,
    background: request.background,
    selection: { ...request.selection },
    startedAt: request.startedAt,
  };
}
