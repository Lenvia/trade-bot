export const MARKET_DATA_CONTRACT_VERSION = 1;

export const CANONICAL_INTERVALS = Object.freeze([
  "1m",
  "5m",
  "15m",
  "1h",
  "1D",
]);

const DATA_SOURCE_METHODS = Object.freeze([
  "connect",
  "disconnect",
  "reconnectNow",
  "updateSelection",
  "requestHistory",
]);

export function parseProductId(productId) {
  const normalized = String(productId ?? "").trim().toUpperCase();
  const parts = normalized.split(":");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Z0-9_-]+$/.test(part))) {
    throw new RangeError(`Invalid product id: ${productId}`);
  }
  const [venue, marketType, symbol] = parts;
  return { productId: normalized, venue, marketType, symbol };
}

export function normalizeMarketSelection(
  selection,
  { supportedIntervals = CANONICAL_INTERVALS, maxRows = 1000 } = {},
) {
  const instrument = parseProductId(selection?.symbol);
  const interval = String(selection?.interval ?? "");
  const rows = Number(selection?.rows);
  if (!supportedIntervals.includes(interval)) {
    throw new RangeError(`Unsupported canonical interval: ${interval}`);
  }
  if (!Number.isInteger(rows) || rows <= 0 || rows > maxRows) {
    throw new RangeError(`rows must be an integer between 1 and ${maxRows}`);
  }
  return { symbol: instrument.productId, interval, rows };
}

export function createCanonicalBar(value) {
  if (!value || typeof value !== "object") return null;
  const bar = {
    time: Number(value.time),
    open: Number(value.open),
    high: Number(value.high),
    low: Number(value.low),
    close: Number(value.close),
    volume: Number(value.volume ?? 0),
  };
  if (!Object.values(bar).every(Number.isFinite)) return null;
  if (bar.volume < 0 || bar.high < Math.max(bar.open, bar.close, bar.low)) return null;
  if (bar.low > Math.min(bar.open, bar.close, bar.high)) return null;

  const lastTradeTime = value.lastTradeTime == null ? null : Number(value.lastTradeTime);
  if (lastTradeTime != null) {
    if (!Number.isFinite(lastTradeTime)) return null;
    bar.lastTradeTime = lastTradeTime;
  }
  return bar;
}

export function createCanonicalTrade(value) {
  if (!value || typeof value !== "object") return null;
  const side = String(value.side ?? "unknown").toLowerCase();
  const trade = {
    id: value.id == null ? null : String(value.id),
    time: Number(value.time),
    price: Number(value.price),
    size: Number(value.size ?? 0),
    side: side === "buy" || side === "sell" ? side : "unknown",
  };
  if (![trade.time, trade.price, trade.size].every(Number.isFinite) || trade.size < 0) return null;
  return trade;
}

export function assertMarketDataSource(source) {
  if (!source || typeof source !== "object") throw new TypeError("Data Source must be an object");
  for (const method of DATA_SOURCE_METHODS) {
    if (typeof source[method] !== "function") {
      throw new TypeError(`Data Source is missing method: ${method}`);
    }
  }
  if (typeof source.isOpen !== "boolean") {
    throw new TypeError("Data Source must expose a boolean isOpen getter");
  }
  return source;
}
