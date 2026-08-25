export function validateTasks(tasks) {
  return new Map(tasks.map((task) => [task.id, task]));
}
