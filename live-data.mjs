export function applyTradeToBars(bars, trade, intervalMilliseconds) {
  if (!Array.isArray(bars) || bars.length === 0) return { updated: false, created: false };
  if (!Number.isFinite(intervalMilliseconds) || intervalMilliseconds <= 0) {
    return { updated: false, created: false };
  }
  if (![trade?.time, trade?.price, trade?.size].every(Number.isFinite)) {
    return { updated: false, created: false };
  }

  const bucket = Math.floor(trade.time / intervalMilliseconds) * intervalMilliseconds;
  const last = bars.at(-1);
  if (bucket < last.time) return { updated: false, created: false };

  if (bucket > last.time) {
    bars.push({
      time: bucket,
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      volume: trade.size,
    });
    return { updated: true, created: true };
  }

  last.high = Math.max(last.high, trade.price);
  last.low = Math.min(last.low, trade.price);
  last.close = trade.price;
  last.volume += trade.size;
  return { updated: true, created: false };
}

export function mergeHistoryWithLive(historyBars, liveBars) {
  const history = Array.isArray(historyBars) ? historyBars : [];
  const live = Array.isArray(liveBars) ? liveBars : [];
  if (history.length === 0) return live.map((bar) => ({ ...bar }));
  if (live.length === 0) return history.map((bar) => ({ ...bar }));

  const merged = new Map(live.map((bar) => [bar.time, { ...bar }]));
  const latestLiveTime = live.at(-1).time;

  for (const historical of history) {
    const liveBar = merged.get(historical.time);
    if (!liveBar || historical.time < latestLiveTime) {
      merged.set(historical.time, { ...historical });
      continue;
    }

    // 校准正在形成的 K 柱时，保留历史接口返回后的最新 tick，避免 Close 倒退。
    merged.set(historical.time, {
      ...historical,
      high: Math.max(historical.high, liveBar.high),
      low: Math.min(historical.low, liveBar.low),
      close: liveBar.close,
      volume: Math.max(historical.volume, liveBar.volume),
    });
  }

  return [...merged.values()].sort((a, b) => a.time - b.time);
}
