function assertPeriod(period) {
  if (!Number.isInteger(period) || period <= 0) {
    throw new TypeError("period must be a positive integer");
  }
}

export function ema(values, period) {
  assertPeriod(period);
  const output = Array(values.length).fill(null);
  if (values.length < period) return output;

  const seed = values.slice(0, period);
  if (!seed.every(Number.isFinite)) return output;

  let previous = seed.reduce((sum, value) => sum + value, 0) / period;
  output[period - 1] = previous;
  const multiplier = 2 / (period + 1);

  for (let index = period; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) continue;
    previous = value * multiplier + previous * (1 - multiplier);
    output[index] = previous;
  }

  return output;
}

export function rsi(values, period = 14) {
  assertPeriod(period);
  const output = Array(values.length).fill(null);
  if (values.length <= period) return output;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;
  output[period] = rsiFromAverages(averageGain, averageLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    output[index] = rsiFromAverages(averageGain, averageLoss);
  }

  return output;
}

function rsiFromAverages(averageGain, averageLoss) {
  if (averageLoss === 0 && averageGain === 0) return 50;
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

export function macd(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  assertPeriod(fastPeriod);
  assertPeriod(slowPeriod);
  assertPeriod(signalPeriod);
  if (fastPeriod >= slowPeriod) {
    throw new RangeError("fastPeriod must be smaller than slowPeriod");
  }

  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const line = values.map((_, index) => {
    if (fast[index] === null || slow[index] === null) return null;
    return fast[index] - slow[index];
  });

  const validEntries = line
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => value !== null);
  const compactSignal = ema(
    validEntries.map(({ value }) => value),
    signalPeriod,
  );
  const signal = Array(values.length).fill(null);
  validEntries.forEach(({ index }, compactIndex) => {
    signal[index] = compactSignal[compactIndex];
  });

  const histogram = line.map((value, index) => {
    if (value === null || signal[index] === null) return null;
    return value - signal[index];
  });

  return { line, signal, histogram };
}

export function latestFinite(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(values[index])) return values[index];
  }
  return null;
}

export function splitThresholdSegments(values, lowerThreshold = 30, upperThreshold = 70) {
  if (!Number.isFinite(lowerThreshold) || !Number.isFinite(upperThreshold)) {
    throw new TypeError("thresholds must be finite numbers");
  }
  if (lowerThreshold >= upperThreshold) {
    throw new RangeError("lowerThreshold must be smaller than upperThreshold");
  }

  const segments = [];
  for (let index = 0; index < values.length - 1; index += 1) {
    const startValue = values[index];
    const endValue = values[index + 1];
    if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) continue;

    const points = [{ index, value: startValue }];
    const delta = endValue - startValue;
    if (delta !== 0) {
      for (const threshold of [lowerThreshold, upperThreshold]) {
        const ratio = (threshold - startValue) / delta;
        if (ratio > 0 && ratio < 1) {
          points.push({ index: index + ratio, value: threshold });
        }
      }
    }
    points.push({ index: index + 1, value: endValue });
    points.sort((left, right) => left.index - right.index);

    for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
      const from = points[pointIndex];
      const to = points[pointIndex + 1];
      const midpoint = (from.value + to.value) / 2;
      const zone = midpoint > upperThreshold
        ? "overbought"
        : midpoint < lowerThreshold
          ? "oversold"
          : "neutral";
      segments.push({ from, to, zone });
    }
  }
  return segments;
}
