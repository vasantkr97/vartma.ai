import { resolve } from "node:path";

export function resolveWorkspacePath(workspace, requested) {
  const candidate = resolve(workspace, requested);
  if (!candidate.startsWith(resolve(workspace))) throw new Error("Path escapes workspace");
  return candidate;
}
