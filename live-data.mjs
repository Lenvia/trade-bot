export function applyTradeToBars(bars, trade, intervalMilliseconds) {
  if (!Array.isArray(bars)) return { updated: false, created: false };
  if (!Number.isFinite(intervalMilliseconds) || intervalMilliseconds <= 0) {
    return { updated: false, created: false };
  }
  if (![trade?.time, trade?.price, trade?.size].every(Number.isFinite)) {
    return { updated: false, created: false };
  }

  const bucket = Math.floor(trade.time / intervalMilliseconds) * intervalMilliseconds;
  const last = bars.at(-1);
  if (last && bucket < last.time) return { updated: false, created: false };

  if (!last || bucket > last.time) {
    bars.push({
      time: bucket,
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      volume: trade.size,
      lastTradeTime: trade.time,
    });
    return { updated: true, created: true };
  }

  last.high = Math.max(last.high, trade.price);
  last.low = Math.min(last.low, trade.price);
  last.volume += trade.size;
  const previousTradeTime = Number.isFinite(last.lastTradeTime)
    ? last.lastTradeTime
    : last.time;
  if (trade.time >= previousTradeTime) {
    last.close = trade.price;
    last.lastTradeTime = trade.time;
  }
  return { updated: true, created: false };
}

export function createTradeDeduper(maxEntries = 2048) {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new TypeError("maxEntries must be a positive integer");
  }

  const seen = new Set();
  const order = [];
  return {
    accepts(trade) {
      const id = trade?.id;
      if (id === null || id === undefined || id === "") return true;
      const key = String(id);
      if (seen.has(key)) return false;
      seen.add(key);
      order.push(key);
      if (order.length > maxEntries) seen.delete(order.shift());
      return true;
    },
    clear() {
      seen.clear();
      order.length = 0;
    },
  };
}

export function reconcileHistoryWithTrades(
  historyBars,
  baselineBars,
  trades,
  intervalMilliseconds,
) {
  // Baseline 只保护最新的本地 live bar；更早的 closed bars 以历史快照为准。
  const snapshot = mergeHistoryWithLive(historyBars, baselineBars);
  const liveDuringRequest = replayTradesOnBars([], trades, intervalMilliseconds);
  // 请求期间跨过多个 bucket 时，每个 bucket 都包含明确观察到的 live trades。
  return mergeHistoryWithLive(snapshot, liveDuringRequest, { preserveAllLiveBars: true });
}

export function replayTradesOnBars(baselineBars, trades, intervalMilliseconds) {
  const bars = Array.isArray(baselineBars)
    ? baselineBars.map((bar) => ({ ...bar }))
    : [];
  const orderedTrades = Array.isArray(trades)
    ? [...trades].sort((left, right) => left.time - right.time)
    : [];
  for (const trade of orderedTrades) applyTradeToBars(bars, trade, intervalMilliseconds);
  return bars;
}

export function mergeHistoryWithLive(
  historyBars,
  liveBars,
  { preserveAllLiveBars = false } = {},
) {
  const history = Array.isArray(historyBars) ? historyBars : [];
  const live = Array.isArray(liveBars)
    ? [...liveBars].sort((left, right) => left.time - right.time)
    : [];
  if (history.length === 0) return live.map((bar) => ({ ...bar }));
  if (live.length === 0) return history.map((bar) => ({ ...bar }));

  const merged = new Map(live.map((bar) => [bar.time, { ...bar }]));
  const latestLiveTime = live.at(-1).time;

  for (const historical of history) {
    const liveBar = merged.get(historical.time);
    const preserveLive = liveBar
      && (preserveAllLiveBars || historical.time === latestLiveTime);
    if (!preserveLive) {
      merged.set(historical.time, { ...historical });
      continue;
    }

    // 校准正在形成的 K 柱时，保留历史接口返回后的最新 tick，避免 Close 倒退。
    const reconciled = {
      ...historical,
      high: Math.max(historical.high, liveBar.high),
      low: Math.min(historical.low, liveBar.low),
      close: liveBar.close,
      volume: Math.max(historical.volume, liveBar.volume),
    };
    if (Number.isFinite(liveBar.lastTradeTime)) {
      reconciled.lastTradeTime = liveBar.lastTradeTime;
    }
    merged.set(historical.time, reconciled);
  }

  return [...merged.values()].sort((a, b) => a.time - b.time);
}
