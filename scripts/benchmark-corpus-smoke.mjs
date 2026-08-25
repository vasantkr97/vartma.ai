import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { loadEvaluationSuite } from "../packages/evals/dist/index.js";

const executeFile = promisify(execFile);
const suitePath = resolve(process.argv[2] ?? "evals/suites/public-coding-v1.yaml");
const loaded = await loadEvaluationSuite(suitePath);
const classes = new Set(loaded.suite.tasks.map((task) => task.taskClass));
if (loaded.suite.tasks.length < 20)
  throw new Error("Public benchmark must contain at least 20 tasks.");
if (classes.size < 12) throw new Error("Public benchmark must cover at least 12 task classes.");
if (new Set(loaded.suite.tasks.map((task) => task.fixture)).size !== loaded.suite.tasks.length) {
  throw new Error("Every public benchmark task must use an independent fixture.");
}

const failures = [];
for (const task of loaded.suite.tasks) {
  try {
    if (task.verificationFiles.length === 0) {
      throw new Error("task does not declare a hidden verifier");
    }
    if (task.allowedCommands.some((command) => command !== "node")) {
      throw new Error("public fixtures may allow only the cross-platform Node executable");
    }
    const baseline = await exerciseTask(task, false);
    if (baseline) throw new Error("original fixture unexpectedly passes every verifier");
    const reference = await exerciseTask(task, true);
    if (!reference) throw new Error("reference solution does not pass every verifier");
    process.stdout.write(`PASS ${task.id}: failing baseline, passing hidden-verifier reference\n`);
  } catch (error) {
    failures.push(`${task.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Benchmark corpus verification failed:\n${failures.join("\n")}`);
}
process.stdout.write(
  `Benchmark corpus passed: ${String(loaded.suite.tasks.length)} tasks, ${String(classes.size)} task classes, ` +
    `${loaded.digest}.\n`,
);

async function exerciseTask(task, withReferenceSolution) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "vartma-corpus-"));
  const workspace = join(temporaryRoot, "workspace");
  try {
    const fixture = await realpath(resolve(loaded.directory, task.fixture));
    await cp(fixture, workspace, { recursive: true, errorOnExist: true });
    for (const command of task.setup) {
      if (!(await runCommand(command, workspace))) return false;
    }
    if (withReferenceSolution) {
      const solution = resolve(
        dirname(dirname(loaded.path)),
        "solutions",
        basename(loaded.path, extname(loaded.path)),
        task.id,
      );
      if (!(await lstat(solution)).isDirectory())
        throw new Error(`missing solution directory ${solution}`);
      await cp(solution, workspace, { recursive: true, force: true });
    }
    for (const verificationFile of task.verificationFiles) {
      const source = await realpath(resolve(loaded.directory, verificationFile.source));
      const destination = confinedPath(workspace, verificationFile.destination);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { force: true });
    }
    const outcomes = [];
    for (const command of task.verify) outcomes.push(await runCommand(command, workspace));
    return outcomes.every(Boolean);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runCommand(command, workspace) {
  const timeout = Math.min(command.timeoutMs, loaded.suite.timeoutMs);
  try {
    await executeFile(command.command, command.args, {
      cwd: workspace,
      encoding: "utf8",
      windowsHide: true,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: safeCommandEnvironment(),
    });
    return true;
  } catch {
    return false;
  }
}

function confinedPath(workspace, requested) {
  if (isAbsolute(requested)) throw new Error(`absolute verification destination: ${requested}`);
  const candidate = resolve(workspace, requested);
  const path = relative(workspace, candidate);
  if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) return candidate;
  throw new Error(`verification destination escapes workspace: ${requested}`);
}

function safeCommandEnvironment() {
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"];
  return Object.fromEntries(
    allowed.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
}
