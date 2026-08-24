import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const workspace = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packDirectory = await mkdtemp(join(tmpdir(), "vartma-pack-smoke-"));
const installPrefix = await mkdtemp(join(tmpdir(), "vartma-install-smoke-"));
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error("npm_execpath is unavailable; run this smoke test through npm.");
}

const runNpm = (arguments_, options) => execute(process.execPath, [npmCli, ...arguments_], options);

try {
  await runNpm(["pack", join(workspace, "apps", "cli"), "--pack-destination", packDirectory], {
    cwd: workspace,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const tarballName = (await readdir(packDirectory)).find((name) => name.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error("CLI packaging did not produce a tarball.");
  }
  await runNpm(
    ["install", "--global", "--prefix", installPrefix, join(packDirectory, tarballName)],
    {
      cwd: installPrefix,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const { stdout: globalRootOutput } = await runNpm(
    ["root", "--global", "--prefix", installPrefix],
    {
      cwd: installPrefix,
      windowsHide: true,
      timeout: 30_000,
    },
  );
  const globalRoot = globalRootOutput.trim();
  if (!globalRoot) {
    throw new Error("npm did not report the isolated global package root.");
  }
  const cliEntry = join(globalRoot, "@vartma", "cli", "dist", "index.js");
  const { stdout } = await execute(process.execPath, [cliEntry, "--help"], {
    cwd: installPrefix,
    windowsHide: true,
    timeout: 60_000,
  });
  for (const expected of ["start", "stop", "uninstall", "eval", "configure", "doctor"]) {
    if (!stdout.includes(expected)) {
      throw new Error(`Clean CLI help did not contain command "${expected}".`);
    }
  }
  process.stdout.write("Clean global CLI tarball installation passed.\n");
} finally {
  await Promise.all([
    rm(packDirectory, { recursive: true, force: true }),
    rm(installPrefix, { recursive: true, force: true }),
  ]);
}
