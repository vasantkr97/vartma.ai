import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

import {
  createDatabase,
  PrismaEncryptedCanonicalHistoryStore,
} from "../packages/database/dist/index.js";

const suffix = randomBytes(6).toString("hex");
const sourceContainer = `vartma-recovery-source-${suffix}`;
const targetContainer = `vartma-recovery-target-${suffix}`;
const database = "vartma";
const username = "vartma";
const password = randomBytes(24).toString("base64url");
const transcriptMasterKey = randomBytes(32).toString("base64url");
const createdContainers = [];

try {
  await run("docker", ["version", "--format", "{{.Server.Version}}"], { capture: true });
  await startPostgres(sourceContainer);
  createdContainers.push(sourceContainer);
  await startPostgres(targetContainer);
  createdContainers.push(targetContainer);
  await Promise.all([waitForPostgres(sourceContainer), waitForPostgres(targetContainer)]);

  const sourcePort = await publishedPort(sourceContainer);
  const targetPort = await publishedPort(targetContainer);
  await runPrisma(["migrate", "deploy"], databaseEnvironment(sourcePort));

  await runDocker([
    "exec",
    sourceContainer,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    username,
    "-d",
    database,
    "-c",
    `INSERT INTO "Session" ("id", "routingMode", "updatedAt") VALUES ('recovery-proof', 'balanced', CURRENT_TIMESTAMP);`,
  ]);
  const sourceDatabase = createDatabase(databaseUrl(sourcePort));
  try {
    const history = new PrismaEncryptedCanonicalHistoryStore(sourceDatabase, transcriptMasterKey);
    await history.save("recovery-proof", [
      {
        role: "user",
        content: [{ type: "text", text: "authenticated recovery marker" }],
      },
    ]);
  } finally {
    await sourceDatabase.$disconnect();
  }

  const sourceMigrationCount = await scalar(
    sourceContainer,
    'SELECT count(*) FROM "_prisma_migrations";',
  );
  const dump = await run(
    "docker",
    [
      "exec",
      sourceContainer,
      "pg_dump",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "-U",
      username,
      "-d",
      database,
    ],
    { captureBuffer: true, maximumOutputBytes: 128 * 1024 * 1024 },
  );

  await run(
    "docker",
    [
      "exec",
      "-i",
      targetContainer,
      "pg_restore",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      "-U",
      username,
      "-d",
      database,
    ],
    { input: dump },
  );

  const restoredMode = await scalar(
    targetContainer,
    `SELECT "routingMode" FROM "Session" WHERE "id" = 'recovery-proof';`,
  );
  const targetMigrationCount = await scalar(
    targetContainer,
    'SELECT count(*) FROM "_prisma_migrations";',
  );
  if (restoredMode !== "balanced") {
    throw new Error(`Restored session marker was incorrect: "${restoredMode}".`);
  }
  if (targetMigrationCount !== sourceMigrationCount || Number(targetMigrationCount) < 1) {
    throw new Error(
      `Migration history mismatch: source=${sourceMigrationCount}, target=${targetMigrationCount}.`,
    );
  }
  const targetDatabase = createDatabase(databaseUrl(targetPort));
  try {
    const history = new PrismaEncryptedCanonicalHistoryStore(targetDatabase, transcriptMasterKey);
    const restoredTranscript = await history.get("recovery-proof");
    const restoredText = restoredTranscript?.[0]?.content[0];
    if (restoredText?.type !== "text" || restoredText.text !== "authenticated recovery marker") {
      throw new Error(
        "Restored encrypted canonical transcript failed authentication or content verification.",
      );
    }
  } finally {
    await targetDatabase.$disconnect();
  }

  await runPrisma(["migrate", "status"], databaseEnvironment(targetPort));
  process.stdout.write(
    `PostgreSQL recovery smoke passed: ${sourceMigrationCount} migrations, a Vartma session, and ` +
      `its authenticated encrypted transcript were restored into a fresh PostgreSQL 17 instance.\n`,
  );
} finally {
  for (const container of createdContainers.reverse()) {
    assertDisposableContainerName(container);
    await runDocker(["rm", "--force", container], true);
  }
}

async function startPostgres(name) {
  assertDisposableContainerName(name);
  await runDocker([
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_DB=${database}`,
    "--env",
    `POSTGRES_USER=${username}`,
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--tmpfs",
    "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
    "postgres:17-alpine",
  ]);
}

async function waitForPostgres(container) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await run(
      "docker",
      ["exec", container, "pg_isready", "-U", username, "-d", database],
      { capture: true, allowFailure: true },
    );
    if (result.exitCode === 0) return;
    await delay(500);
  }
  throw new Error(`PostgreSQL container ${container} did not become ready within 30 seconds.`);
}

async function publishedPort(container) {
  const result = await run("docker", ["port", container, "5432/tcp"], { capture: true });
  const match = result.stdout.match(/127\.0\.0\.1:(\d+)/);
  if (!match) {
    throw new Error(`Could not resolve the loopback PostgreSQL port for ${container}.`);
  }
  return Number(match[1]);
}

async function scalar(container, sql) {
  const result = await run(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-A",
      "-t",
      "-U",
      username,
      "-d",
      database,
      "-c",
      sql,
    ],
    { capture: true },
  );
  return result.stdout.trim();
}

function databaseEnvironment(port) {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl(port),
  };
}

function databaseUrl(port) {
  return `postgresql://${username}:${encodeURIComponent(password)}@127.0.0.1:${String(port)}/${database}?schema=public`;
}

function runPrisma(args, env) {
  return run(process.execPath, ["node_modules/prisma/build/index.js", ...args], { env });
}

async function runDocker(args, allowFailure = false) {
  return run("docker", args, { capture: true, allowFailure });
}

function assertDisposableContainerName(name) {
  if (!/^vartma-recovery-(?:source|target)-[a-f0-9]{12}$/.test(name)) {
    throw new Error(`Refusing to operate on non-disposable container name "${name}".`);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      shell: false,
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const maximumOutputBytes = options.maximumOutputBytes ?? 16 * 1024 * 1024;

    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        child.kill();
        rejectRun(new Error(`${command} output exceeded ${String(maximumOutputBytes)} bytes.`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (exitCode) => {
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (exitCode !== 0 && !options.allowFailure) {
        rejectRun(
          new Error(
            `${command} ${args.join(" ")} failed with exit ${String(exitCode)}${stderrText ? `: ${stderrText}` : ""}`,
          ),
        );
        return;
      }
      if (!options.capture && !options.captureBuffer && stderrText) {
        process.stderr.write(`${stderrText}\n`);
      }
      resolveRun(
        options.captureBuffer
          ? stdoutBuffer
          : { exitCode: exitCode ?? 1, stdout: stdoutBuffer.toString("utf8"), stderr: stderrText },
      );
    });
    if (options.input) child.stdin.end(options.input);
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
