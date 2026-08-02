export const HISTORY_RETRY_DELAYS_MS = Object.freeze([
  2_000,
  5_000,
  15_000,
  30_000,
  60_000,
]);

const STREAM_ACTIVITY_STALE_MS = 45_000;
const RECENT_TRADE_MS = 5_000;
const TRANSPORT_DELAYED_MS = 5_000;

export function historyRetryDelay(attempt, random = Math.random) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError("History retry attempt must be a positive integer");
  }
  const base = HISTORY_RETRY_DELAYS_MS[Math.min(attempt - 1, HISTORY_RETRY_DELAYS_MS.length - 1)];
  const sample = Math.min(1, Math.max(0, Number(random())));
  return Math.round(base * (0.85 + sample * 0.3));
}

export function deriveStreamHealth({
  isOpen,
  lastTradeReceivedAt,
  lastTransportActivityAt,
  transportDelayMs,
  now = Date.now(),
}) {
  if (!isOpen) return { badge: "OFFLINE", badgeClass: "idle", detail: "等待连接" };

  const activityAge = age(now, lastTransportActivityAt);
  const tradeAge = age(now, lastTradeReceivedAt);
  if (activityAge != null && activityAge > STREAM_ACTIVITY_STALE_MS) {
    return { badge: "STALE", badgeClass: "stale", detail: `连接 ${formatHealthAge(activityAge)} 无响应` };
  }
  if (tradeAge == null) {
    return { badge: "CONNECTED", badgeClass: "quiet", detail: "等待首笔 tick" };
  }
  if (tradeAge <= RECENT_TRADE_MS && Number(transportDelayMs) > TRANSPORT_DELAYED_MS) {
    return { badge: "DELAYED", badgeClass: "delayed", detail: `最后 tick ${formatHealthAge(tradeAge)}前` };
  }
  if (tradeAge <= RECENT_TRADE_MS) {
    return { badge: "LIVE", badgeClass: "live", detail: `最后 tick ${formatHealthAge(tradeAge)}前` };
  }
  return { badge: "QUIET", badgeClass: "quiet", detail: `最后 tick ${formatHealthAge(tradeAge)}前 · 连接有响应` };
}

function age(now, timestamp) {
  return timestamp == null ? null : Math.max(0, now - timestamp);
}

function formatHealthAge(milliseconds) {
  if (milliseconds < 1_000) return "<1s";
  if (milliseconds < 60_000) return `${Math.floor(milliseconds / 1_000)}s`;
  return `${Math.floor(milliseconds / 60_000)}m`;
}
