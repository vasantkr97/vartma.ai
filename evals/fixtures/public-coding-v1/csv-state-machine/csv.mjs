export function parseCsv(source) {
  return source
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.split(","));
}
