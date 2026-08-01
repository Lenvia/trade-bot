export function formatPrice(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 100 ? 2 : 6,
  }).format(value);
}

export function compactNumber(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 3,
  }).format(value);
}

export function formatIndicator(value) {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(Math.abs(value) >= 100 ? 2 : 4);
}

export function formatCrosshairTime(time, interval) {
  const options = interval === "1D"
    ? { year: "numeric", month: "2-digit", day: "2-digit" }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" };
  return new Date(time).toLocaleString("zh-CN", options);
}
