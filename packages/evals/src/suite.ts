import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { TASK_CLASSES } from "@vartma/routing";
import { parse } from "yaml";
import { z } from "zod";

const commandSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(30 * 60 * 1_000)
      .default(120_000),
  })
  .strict();

const verificationFileSchema = z
  .object({
    source: z.string().min(1),
    destination: z.string().min(1),
  })
  .strict();

export const evaluationSuiteSchema = z
  .object({
    dataset: z.string().min(1),
    datasetVersion: z.string().min(1),
    harnessVersion: z.string().min(1).default("vartma-langgraph-agent-v1"),
    promptTemplateVersion: z.string().min(1),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 1_000),
    maxAttempts: z.number().int().positive().max(10).default(3),
    cacheEnabled: z.boolean().default(true),
    maxAgentTurns: z.number().int().positive().max(100).default(30),
    maxOutputTokens: z.number().int().positive().max(1_000_000).default(4096),
    tasks: z
      .array(
        z
          .object({
            id: z.string().min(1),
            taskClass: z.enum(TASK_CLASSES),
            fixture: z.string().min(1),
            prompt: z.string().min(1),
            allowedCommands: z.array(z.string().min(1)).default([]),
            setup: z.array(commandSchema).default([]),
            verificationFiles: z.array(verificationFileSchema).default([]),
            verify: z.array(commandSchema).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((suite, context) => {
    const ids = new Set<string>();
    for (const [index, task] of suite.tasks.entries()) {
      if (ids.has(task.id)) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "id"],
          message: `Duplicate evaluation task ID "${task.id}".`,
        });
      }
      ids.add(task.id);
    }
  });

export type EvaluationSuite = z.infer<typeof evaluationSuiteSchema>;
export type EvaluationTask = EvaluationSuite["tasks"][number];
export type EvaluationCommand = EvaluationTask["verify"][number];

export async function loadEvaluationSuite(path: string): Promise<{
  path: string;
  directory: string;
  suite: EvaluationSuite;
  digest: string;
}> {
  const suitePath = resolve(path);
  const suiteSource = await readFile(suitePath);
  const value: unknown = parse(suiteSource.toString("utf8"));
  const suite = evaluationSuiteSchema.parse(value);
  return {
    path: suitePath,
    directory: dirname(suitePath),
    suite,
    digest: await evaluationSuiteDigest(suitePath, suiteSource, suite),
  };
}

async function evaluationSuiteDigest(
  suitePath: string,
  suiteSource: Buffer,
  suite: EvaluationSuite,
): Promise<string> {
  const hash = createHash("sha256");
  hashEntry(hash, "suite.yaml", suiteSource);
  const suiteDirectory = dirname(suitePath);
  for (const task of [...suite.tasks].sort((left, right) => left.id.localeCompare(right.id))) {
    const fixture = await realpath(resolve(suiteDirectory, task.fixture));
    if (!(await lstat(fixture)).isDirectory()) {
      throw new Error(`Evaluation fixture "${task.fixture}" must be a directory.`);
    }
    for (const file of await regularFiles(fixture)) {
      hashEntry(
        hash,
        `fixture:${task.id}:${portablePath(relative(fixture, file))}`,
        await readFile(file),
      );
    }
    for (const [index, verificationFile] of task.verificationFiles.entries()) {
      const source = await realpath(resolve(suiteDirectory, verificationFile.source));
      if (!(await lstat(source)).isFile()) {
        throw new Error(`Verification source "${verificationFile.source}" must be a regular file.`);
      }
      hashEntry(
        hash,
        `verification:${task.id}:${String(index)}:${verificationFile.destination}`,
        await readFile(source),
      );
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

async function regularFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Evaluation fixtures may not contain symbolic links: ${path}`);
      }
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  await visit(directory);
  return output;
}

function hashEntry(hash: ReturnType<typeof createHash>, name: string, content: Buffer): void {
  hash.update(name, "utf8");
  hash.update("\0", "utf8");
  hash.update(String(content.length), "utf8");
  hash.update("\0", "utf8");
  hash.update(content);
  hash.update("\0", "utf8");
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}
