import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = join(workspace, "apps", "cli", "node_modules", "@vartma");
const clean = process.argv.includes("--clean");

if (clean) {
  await rm(bundleRoot, { recursive: true, force: true });
  process.exit(0);
}

const packages = [
  ["canonical", join("packages", "canonical")],
  ["config", join("packages", "config")],
  ["console", join("apps", "console")],
  ["database", join("packages", "database")],
  ["evals", join("packages", "evals")],
  ["gateway", join("apps", "gateway")],
  ["providers", join("packages", "providers")],
  ["routing", join("packages", "routing")],
];

await rm(bundleRoot, { recursive: true, force: true });
await mkdir(bundleRoot, { recursive: true });
for (const [name, relativeSource] of packages) {
  const source = join(workspace, relativeSource);
  const destination = join(bundleRoot, name);
  await mkdir(destination, { recursive: true });
  await cp(join(source, "dist"), join(destination, "dist"), { recursive: true });
  await removeDevelopmentArtifacts(destination);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const packagedManifest = {
    name: manifest.name,
    version: manifest.version,
    type: manifest.type,
    ...(manifest.main ? { main: manifest.main } : {}),
    ...(manifest.exports
      ? {
          exports: Object.fromEntries(
            Object.entries(manifest.exports).map(([key, value]) => [
              key,
              typeof value === "string" ? value : value.default,
            ]),
          ),
        }
      : {}),
  };
  await writeFile(
    join(destination, "package.json"),
    `${JSON.stringify(packagedManifest, null, 2)}\n`,
    "utf8",
  );
}

async function removeDevelopmentArtifacts(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name.endsWith(".map") ||
            entry.name.endsWith(".d.ts") ||
            entry.name === ".tsbuildinfo"),
      )
      .map((entry) => rm(join(entry.parentPath, entry.name), { force: true })),
  );
}
