export function validateTasks(tasks) {
  const graph = new Map();
  for (const task of tasks) {
    if (!task || typeof task.id !== "string" || !task.id || typeof task.run !== "function")
      throw new TypeError("invalid task");
    if (graph.has(task.id)) throw new Error(`Duplicate task: ${task.id}`);
    graph.set(task.id, { ...task, dependsOn: [...(task.dependsOn ?? [])] });
  }
  for (const task of graph.values()) {
    for (const dependency of task.dependsOn) {
      if (!graph.has(dependency))
        throw new Error(`Missing dependency ${dependency} for ${task.id}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const visit = (id) => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      throw new Error(`Dependency cycle: ${[...stack.slice(start), id].join(" -> ")}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of graph.get(id).dependsOn) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
  return graph;
}
