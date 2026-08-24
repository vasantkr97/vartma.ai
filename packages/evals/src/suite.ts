import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
}> {
  const suitePath = resolve(path);
  const value: unknown = parse(await readFile(suitePath, "utf8"));
  return {
    path: suitePath,
    directory: dirname(suitePath),
    suite: evaluationSuiteSchema.parse(value),
  };
}
