export function getByPointer(document, pointer) {
  return pointer
    .split("/")
    .slice(1)
    .reduce((value, key) => value?.[key], document);
}
