export async function mapPool(values, concurrency, mapper) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  return Promise.all(values.map((value, index) => mapper(value, index)));
}
