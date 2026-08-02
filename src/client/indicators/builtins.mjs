import { macd, rsi } from "./calculations.mjs";
import {
  calculateRegisteredIndicators,
  createIndicatorRegistry,
} from "./registry.mjs";

const RSI_DEFINITION = {
  id: "rsi14",
  label: "Relative Strength Index 14",
  shortLabel: "RSI 14",
  compute(bars) {
    return { value: rsi(bars.map(({ close }) => close), 14) };
  },
  pane: {
    height: 260,
    scale: { mode: "fixed", min: 0, max: 100 },
    bands: [
      { from: 70, to: 100, color: "rgba(255,94,115,0.07)" },
      { from: 30, to: 70, color: "rgba(83,216,251,0.025)" },
      { from: 0, to: 30, color: "rgba(83,216,251,0.065)" },
    ],
    levels: [
      { value: 30, label: "30 超卖", color: "#53d8fb" },
      { value: 50, label: "50 中线", color: "#8d99a6", dash: [3, 5] },
      { value: 70, label: "70 超买", color: "#ff5e73" },
    ],
    series: [{
      key: "value",
      type: "threshold-line",
      color: "#c7ff3d",
      lineWidth: 2,
      lower: 30,
      upper: 70,
      colors: { lower: "#53d8fb", middle: "#c7ff3d", upper: "#ff5e73" },
      marker: true,
    }],
    readouts: [{ key: "value", label: "RSI" }],
  },
};

const MACD_DEFINITION = {
  id: "macd12_26_9",
  label: "MACD 12 / 26 / 9",
  shortLabel: "MACD",
  compute(bars) {
    return macd(bars.map(({ close }) => close), 12, 26, 9);
  },
  pane: {
    height: 240,
    scale: { mode: "symmetric" },
    levels: [{ value: 0, label: "0", color: "rgba(141,153,166,0.35)" }],
    series: [
      {
        key: "histogram",
        type: "histogram",
        positiveColor: "rgba(98,230,167,0.55)",
        negativeColor: "rgba(255,94,115,0.55)",
      },
      { key: "line", type: "line", color: "#53d8fb", lineWidth: 1.6 },
      { key: "signal", type: "line", color: "#ffcb6b", lineWidth: 1.6 },
    ],
    readouts: [
      { key: "line", label: "MACD" },
      { key: "signal", label: "Signal" },
      { key: "histogram", label: "Hist" },
    ],
  },
};

export const INDICATOR_REGISTRY = createIndicatorRegistry([
  RSI_DEFINITION,
  MACD_DEFINITION,
]);

export const DEFAULT_INDICATOR_IDS = Object.freeze([
  "rsi14",
  "macd12_26_9",
]);

export const EMPTY_INDICATOR_SET = new Map();

export function calculateIndicatorSet(
  bars,
  activeIds = DEFAULT_INDICATOR_IDS,
  registry = INDICATOR_REGISTRY,
) {
  if (!Array.isArray(bars)) throw new TypeError("bars must be an array");
  const closes = bars.map(({ close }) => close);
  if (!closes.every(Number.isFinite)) {
    throw new TypeError("bars must contain finite close values");
  }
  if (bars.length === 0 || activeIds.length === 0) return EMPTY_INDICATOR_SET;
  return calculateRegisteredIndicators(bars, activeIds, registry);
}
