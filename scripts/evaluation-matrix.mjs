import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  loadEvaluationSuite,
  parseEvaluationJsonLines,
  summarizeEvaluation,
} from "../packages/evals/dist/index.js";

const executeFile = promisify(execFile);

const options = parseArguments(process.argv.slice(2));
const suitePath = resolve(options.suite ?? "evals/suites/public-coding-v1.yaml");
const configPath = resolve(options.config ?? "configs/vartma.example.yaml");
const fixedModels = options.fixed;
if (fixedModels.length === 0) throw new Error("At least one --fixed <model-id> is required.");
const modes = (options.modes ?? "balanced,eco")
  .split(",")
  .map((mode) => mode.trim())
  .filter(Boolean);
if (modes.some((mode) => !["balanced", "eco", "quality"].includes(mode))) {
  throw new Error("--modes accepts a comma-separated subset of balanced,eco,quality.");
}
const targets = [
  ...fixedModels.map((model) => `fixed:${model}`),
  ...[...new Set(modes)].map((mode) => `router:${mode}`),
];
const baselineModel = options.baseline ?? fixedModels[0];
if (!fixedModels.includes(baselineModel)) {
  throw new Error("--baseline must name one of the models supplied with --fixed.");
}
const loaded = await loadEvaluationSuite(suitePath);
const source = await sourceIdentity();

if (options.plan) {
  process.stdout.write(
    `${JSON.stringify(
      {
        suite: relative(process.cwd(), loaded.path),
        dataset: `${loaded.suite.dataset}@${loaded.suite.datasetVersion}`,
        datasetDigest: loaded.digest,
        tasks: loaded.suite.tasks.length,
        targets,
        baseline: `fixed:${baselineModel}`,
        source,
      },
      null,
      2,
    )}\n`,
  );
} else {
  const outputDirectory = resolve(
    options.outputDir ?? `eval-results/matrix-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
  );
  await mkdir(dirname(outputDirectory), { recursive: true });
  await mkdir(outputDirectory, { recursive: false });
  const resultPaths = [];
  for (const [index, target] of targets.entries()) {
    const output = resolve(
      outputDirectory,
      `${String(index + 1).padStart(2, "0")}-${safeName(target)}.jsonl`,
    );
    const arguments_ = [
      "apps/cli/dist/index.js",
      "eval",
      "run",
      suitePath,
      "--target",
      target,
      "--output",
      output,
      "--config",
      configPath,
      ...(options.gatewayUrl ? ["--gateway-url", options.gatewayUrl] : []),
      ...(options.noPersist ? ["--no-persist"] : []),
      ...(options.keepWorkspaces ? ["--keep-workspaces"] : []),
    ];
    process.stdout.write(`\n=== ${target} ===\n`);
    const exitCode = await run(process.execPath, arguments_);
    if (exitCode !== 0 && exitCode !== 2) {
      throw new Error(`Evaluation target ${target} failed before producing a valid result set.`);
    }
    resultPaths.push(output);
  }

  const combinedPath = resolve(outputDirectory, "results.jsonl");
  const combined = (await Promise.all(resultPaths.map((path) => readFile(path, "utf8")))).join("");
  await writeFile(combinedPath, combined, { encoding: "utf8", flag: "wx" });
  const report = summarizeEvaluation(parseEvaluationJsonLines(combined), `fixed:${baselineModel}`);
  const reportPath = resolve(outputDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  const manifestPath = resolve(outputDirectory, "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        version: 1,
        createdAt: new Date().toISOString(),
        suite: relative(process.cwd(), loaded.path),
        dataset: loaded.suite.dataset,
        datasetVersion: loaded.suite.datasetVersion,
        datasetDigest: loaded.digest,
        tasks: loaded.suite.tasks.length,
        targets,
        baseline: `fixed:${baselineModel}`,
        source,
        comparable: report.comparable,
        files: { results: "results.jsonl", report: "report.json" },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  if (!report.comparable) {
    throw new Error(
      `Evaluation matrix is not comparable: ${report.comparabilityIssues.join("; ")}`,
    );
  }
  process.stdout.write(
    `\nComparable matrix complete: ${outputDirectory}\n` +
      `Dataset: ${loaded.digest}\n` +
      `Report: ${reportPath}\n`,
  );
}

function parseArguments(arguments_) {
  const output = { fixed: [] };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--plan") output.plan = true;
    else if (argument === "--no-persist") output.noPersist = true;
    else if (argument === "--keep-workspaces") output.keepWorkspaces = true;
    else if (
      [
        "--fixed",
        "--baseline",
        "--modes",
        "--suite",
        "--config",
        "--gateway-url",
        "--output-dir",
      ].includes(argument)
    ) {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      const key = {
        "--baseline": "baseline",
        "--modes": "modes",
        "--suite": "suite",
        "--config": "config",
        "--gateway-url": "gatewayUrl",
        "--output-dir": "outputDir",
      }[argument];
      if (argument === "--fixed") output.fixed.push(value);
      else output[key] = value;
    } else {
      throw new Error(`Unknown evaluation matrix argument: ${argument}`);
    }
  }
  output.fixed = [...new Set(output.fixed)];
  return output;
}

function safeName(target) {
  return target
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 100);
}

async function sourceIdentity() {
  try {
    const [{ stdout: revision }, { stdout: status }] = await Promise.all([
      executeFile("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }),
      executeFile("git", ["status", "--short", "--untracked-files=no"], {
        encoding: "utf8",
        windowsHide: true,
      }),
    ]);
    return { revision: revision.trim(), dirty: Boolean(status.trim()) };
  } catch {
    return {
      revision: process.env.VARTMA_BUILD_REVISION ?? process.env.GITHUB_SHA ?? "unknown",
      dirty: null,
    };
  }
}

function run(command, arguments_) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      env: process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun(code ?? 1));
  });
}
