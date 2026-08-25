import { validateTasks } from "./graph.mjs";

export class ScheduleError extends Error {
  constructor(results, failures, skipped) {
    super("One or more scheduled tasks failed");
    this.results = results;
    this.failures = failures;
    this.skipped = skipped;
  }
}

export async function runSchedule(tasks, { concurrency = Number.POSITIVE_INFINITY } = {}) {
  if (!(
    concurrency === Number.POSITIVE_INFINITY ||
    (Number.isInteger(concurrency) && concurrency > 0)
  )) {
    throw new RangeError("concurrency must be positive");
  }
  const graph = validateTasks(tasks);
  const pending = new Set(graph.keys());
  const running = new Map();
  const results = new Map();
  const failures = new Map();
  const skipped = new Set();

  while (pending.size > 0 || running.size > 0) {
    for (const id of [...pending]) {
      if (running.size >= concurrency) break;
      const task = graph.get(id);
      if (
        task.dependsOn.some((dependency) => failures.has(dependency) || skipped.has(dependency))
      ) {
        pending.delete(id);
        skipped.add(id);
        continue;
      }
      if (!task.dependsOn.every((dependency) => results.has(dependency))) continue;
      pending.delete(id);
      const promise = Promise.resolve()
        .then(() => task.run())
        .then(
          (value) => ({ id, value }),
          (error) => ({ id, error }),
        );
      running.set(id, promise);
    }
    if (running.size === 0) continue;
    const settled = await Promise.race(running.values());
    running.delete(settled.id);
    if ("error" in settled) failures.set(settled.id, settled.error);
    else results.set(settled.id, settled.value);
  }

  const orderedResults = new Map(
    tasks.filter((task) => results.has(task.id)).map((task) => [task.id, results.get(task.id)]),
  );
  const orderedFailures = new Map(
    tasks.filter((task) => failures.has(task.id)).map((task) => [task.id, failures.get(task.id)]),
  );
  const orderedSkipped = new Set(
    tasks.filter((task) => skipped.has(task.id)).map((task) => task.id),
  );
  if (orderedFailures.size > 0)
    throw new ScheduleError(orderedResults, orderedFailures, orderedSkipped);
  return orderedResults;
}
