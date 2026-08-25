export function formatBytes(value, { binary = false, precision = 1 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError("value must be finite");
  if (!Number.isInteger(precision) || precision < 0 || precision > 3)
    throw new RangeError("precision must be 0 through 3");
  if (Object.is(value, -0) || value === 0) return "0 B";
  const base = binary ? 1024 : 1000;
  const units = binary ? ["B", "KiB", "MiB", "GiB", "TiB"] : ["B", "kB", "MB", "GB", "TB"];
  const absolute = Math.abs(value);
  const index = Math.min(units.length - 1, Math.floor(Math.log(absolute) / Math.log(base)));
  const scaled = value / base ** Math.max(0, index);
  const formatted = Number(scaled.toFixed(index === 0 ? 0 : precision)).toString();
  return `${formatted} ${units[Math.max(0, index)]}`;
}
