const SERIES_TYPES = new Set(["line", "histogram", "threshold-line"]);
const SCALE_MODES = new Set(["fixed", "auto", "symmetric"]);

export function createIndicatorRegistry(initialDefinitions = []) {
  const definitions = new Map();

  function register(definition) {
    const normalized = validateDefinition(definition);
    if (definitions.has(normalized.id)) {
      throw new RangeError(`Duplicate indicator id: ${normalized.id}`);
    }
    definitions.set(normalized.id, normalized);
    return normalized;
  }

  for (const definition of initialDefinitions) register(definition);

  return Object.freeze({
    register,
    get(id) {
      return definitions.get(id) ?? null;
    },
    has(id) {
      return definitions.has(id);
    },
    list() {
      return [...definitions.values()];
    },
  });
}

export function calculateRegisteredIndicators(bars, activeIds, registry) {
  if (!Array.isArray(bars)) throw new TypeError("bars must be an array");
  if (!Array.isArray(activeIds)) throw new TypeError("activeIds must be an array");
  const seen = new Set();
  const output = new Map();

  for (const id of activeIds) {
    if (seen.has(id)) throw new RangeError(`Duplicate active indicator id: ${id}`);
    seen.add(id);
    const definition = registry.get(id);
    if (!definition) throw new RangeError(`Unknown indicator id: ${id}`);

    try {
      const data = definition.compute(bars);
      validateComputedData(definition, data, bars.length);
      output.set(id, { definition, data, error: null });
    } catch (error) {
      output.set(id, {
        definition,
        data: null,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return output;
}

function validateDefinition(definition) {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("Indicator definition must be an object");
  }
  const id = String(definition.id ?? "");
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) throw new RangeError(`Invalid indicator id: ${id}`);
  if (typeof definition.compute !== "function") {
    throw new TypeError(`Indicator ${id} requires a compute function`);
  }
  const pane = definition.pane;
  if (!pane || typeof pane !== "object" || !Array.isArray(pane.series) || pane.series.length === 0) {
    throw new TypeError(`Indicator ${id} requires pane.series`);
  }
  const scaleMode = pane.scale?.mode ?? "auto";
  if (!SCALE_MODES.has(scaleMode)) {
    throw new RangeError(`Indicator ${id} has unsupported scale mode: ${scaleMode}`);
  }
  const height = Number(pane.height ?? 240);
  if (!Number.isFinite(height) || height <= 0) {
    throw new RangeError(`Indicator ${id} has an invalid pane height`);
  }
  if (scaleMode === "fixed") {
    const min = Number(pane.scale?.min);
    const max = Number(pane.scale?.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
      throw new RangeError(`Indicator ${id} has an invalid fixed scale`);
    }
  }
  const seriesKeys = new Set();
  for (const series of pane.series) {
    if (!series?.key || !SERIES_TYPES.has(series.type)) {
      throw new TypeError(`Indicator ${id} has an invalid series descriptor`);
    }
    if (seriesKeys.has(series.key)) {
      throw new RangeError(`Indicator ${id} has a duplicate series key: ${series.key}`);
    }
    seriesKeys.add(series.key);
    if (series.type === "threshold-line") {
      if (!Number.isFinite(series.lower) || !Number.isFinite(series.upper) || series.lower >= series.upper) {
        throw new RangeError(`Indicator ${id}.${series.key} has invalid thresholds`);
      }
    }
  }
  for (const band of pane.bands ?? []) {
    if (!Number.isFinite(band?.from) || !Number.isFinite(band?.to)) {
      throw new RangeError(`Indicator ${id} has an invalid band`);
    }
  }
  for (const level of pane.levels ?? []) {
    if (!Number.isFinite(level?.value)) {
      throw new RangeError(`Indicator ${id} has an invalid level`);
    }
  }
  const readoutKeys = new Set();
  for (const readout of pane.readouts ?? []) {
    if (!readout?.key || readoutKeys.has(readout.key)) {
      throw new RangeError(`Indicator ${id} has an invalid or duplicate readout key`);
    }
    readoutKeys.add(readout.key);
  }
  return Object.freeze({
    ...definition,
    id,
    label: String(definition.label ?? id),
    shortLabel: String(definition.shortLabel ?? definition.label ?? id),
    pane: Object.freeze({
      ...pane,
      height: Math.max(180, height),
      scale: Object.freeze({ mode: scaleMode, ...pane.scale }),
      bands: Object.freeze([...(pane.bands ?? [])]),
      levels: Object.freeze([...(pane.levels ?? [])]),
      series: Object.freeze(pane.series.map((series) => Object.freeze({ ...series }))),
      readouts: Object.freeze((pane.readouts ?? []).map((readout) => Object.freeze({ ...readout }))),
    }),
  });
}

function validateComputedData(definition, data, expectedLength) {
  if (!data || typeof data !== "object") {
    throw new TypeError(`Indicator ${definition.id} must return an object`);
  }
  const requiredKeys = new Set([
    ...definition.pane.series.map(({ key }) => key),
    ...definition.pane.readouts.map(({ key }) => key),
  ]);
  for (const key of requiredKeys) {
    const values = data[key];
    if (!Array.isArray(values) || values.length !== expectedLength) {
      throw new RangeError(`Indicator ${definition.id}.${key} must align with bars`);
    }
    if (!values.every((value) => value === null || Number.isFinite(value))) {
      throw new TypeError(`Indicator ${definition.id}.${key} must contain finite values or null`);
    }
  }
}
