export function bucketByUtcDay(timestamps) {
  const buckets = {};
  for (const timestamp of timestamps) {
    if (typeof timestamp !== "string") throw new TypeError("timestamp must be a string");
    const milliseconds = Date.parse(timestamp);
    if (!Number.isFinite(milliseconds)) throw new RangeError(`Invalid timestamp: ${timestamp}`);
    const day = new Date(milliseconds).toISOString().slice(0, 10);
    (buckets[day] ??= []).push(timestamp);
  }
  return buckets;
}
