import { macd, rsi } from "./indicators.mjs";

export const EMPTY_INDICATOR_SET = Object.freeze({
  rsi14: Object.freeze([]),
  macd12_26_9: Object.freeze({
    line: Object.freeze([]),
    signal: Object.freeze([]),
    histogram: Object.freeze([]),
  }),
});

// 当前 Dashboard 的派生数据入口。公式保留在 indicators.mjs；未来新增指标时，
// 在这里组合输出稳定的数据结构，不需要让 Data Source 或 Canvas 知道计算细节。
export function calculateIndicatorSet(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return EMPTY_INDICATOR_SET;
  const closes = bars.map(({ close }) => close);
  if (!closes.every(Number.isFinite)) {
    throw new TypeError("bars must contain finite close values");
  }
  return {
    rsi14: rsi(closes, 14),
    macd12_26_9: macd(closes, 12, 26, 9),
  };
}
