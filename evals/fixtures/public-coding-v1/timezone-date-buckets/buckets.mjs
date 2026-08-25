export function bucketByUtcDay(timestamps) {
  const buckets = {};
  for (const timestamp of timestamps) {
    const day = timestamp.slice(0, 10);
    (buckets[day] ??= []).push(timestamp);
  }
  return buckets;
}
