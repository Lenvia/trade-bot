const endpoint = "wss://gocharting.com/sdk/ws";
const symbol = "BYBIT:FUTURE:BTCUSDT";
const result = {
  welcome: false,
  history: false,
  trade: false,
  barCount: 0,
  firstBarTime: null,
  lastBarTime: null,
  sampleTradeTime: null,
};

if (typeof WebSocket === "undefined") {
  throw new Error("This smoke test requires a Node.js runtime with global WebSocket support.");
}

const socket = new WebSocket(endpoint);
const timeout = setTimeout(() => finish(false, "Timed out after 20 seconds"), 20_000);

socket.addEventListener("open", () => {
  socket.send("PING");
  socket.send(JSON.stringify({
    request_id: 1,
    command: "timeseries",
    payload: {
      symbol,
      interval: "5m",
      session: "RTH",
      hint: "rows=20",
      echo: "codex-smoke-test",
    },
  }));
  socket.send(JSON.stringify({ command: "SUBSCRIBE", channel: "trade", payload: [symbol] }));
});

socket.addEventListener("message", ({ data }) => {
  if (typeof data !== "string") return;
  if (data.startsWith("Welcome-")) {
    result.welcome = true;
    checkComplete();
    return;
  }
  if (data.startsWith("PONG")) return;

  const message = JSON.parse(data);
  if (message.command === "ERROR") {
    finish(false, message.message ?? message.out?.message ?? "GoCharting returned an error");
    return;
  }
  if (message.command === "timeseries" && [1, 2].includes(message.final)) {
    const bars = message.payload?.bars;
    const flattened = Array.isArray(bars)
      ? bars
      : Object.values(bars ?? {}).flatMap((group) => (Array.isArray(group) ? group : []));
    result.barCount += flattened.length;
    result.firstBarTime ??= flattened.at(0)?.date ?? null;
    result.lastBarTime = flattened.at(-1)?.date ?? result.lastBarTime;
    result.history = result.barCount > 0;
    checkComplete();
  }
  if (message.channel === "trade") {
    const trades = message.payload?.[symbol] ?? [];
    result.trade = trades.length > 0;
    result.sampleTradeTime ??= trades.at(0)?.t_ms ?? null;
    checkComplete();
  }
});

socket.addEventListener("error", () => finish(false, "WebSocket transport error"));

function checkComplete() {
  if (result.welcome && result.history && result.trade) {
    finish(true, "Welcome, OHLCV history, and live trades received");
  }
}

function finish(success, message) {
  clearTimeout(timeout);
  console.log(JSON.stringify({ endpoint, symbol, ...result, message }, null, 2));
  if (socket.readyState < WebSocket.CLOSING) socket.close(1000, "Smoke test complete");
  process.exitCode = success ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 50);
}
