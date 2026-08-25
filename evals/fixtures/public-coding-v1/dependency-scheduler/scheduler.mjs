import { validateTasks } from "./graph.mjs";

export class ScheduleError extends Error {}

export async function runSchedule(tasks) {
  validateTasks(tasks);
  const results = new Map();
  for (const task of tasks) results.set(task.id, await task.run());
  return results;
}
