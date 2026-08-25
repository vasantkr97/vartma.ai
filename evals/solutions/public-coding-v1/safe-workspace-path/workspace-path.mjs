import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

export function resolveWorkspacePath(workspace, requested) {
  if (typeof requested !== "string" || requested.includes("\0"))
    throw new TypeError("invalid path");
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    throw new Error("invalid encoded path");
  }
  if (isAbsolute(decoded) || win32.isAbsolute(decoded))
    throw new Error("absolute paths are forbidden");
  const normalized = decoded.replace(/[\\/]+/gu, sep);
  const root = resolve(workspace);
  const candidate = resolve(root, normalized);
  const path = relative(root, candidate);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path)))
    return candidate;
  throw new Error("Path escapes workspace");
}
