export function getByPointer(document, pointer) {
  if (typeof pointer !== "string") throw new TypeError("pointer must be a string");
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) throw new SyntaxError("JSON Pointer must start with /");
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~(?:[^01]|$)/u.test(token))
        throw new SyntaxError(`Invalid JSON Pointer escape: ${token}`);
      return token.replace(/~1/gu, "/").replace(/~0/gu, "~");
    });
  let value = document;
  for (const token of tokens) {
    if (
      value === null ||
      value === undefined ||
      (typeof value !== "object" && typeof value !== "function")
    )
      return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, token)) return undefined;
    value = value[token];
  }
  return value;
}
