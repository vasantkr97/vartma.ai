export function stableTopologicalSort(nodes, dependencies) {
  if (new Set(nodes).size !== nodes.length) throw new Error("Duplicate preferred node");
  const declared = Object.keys(dependencies);
  const order = [...nodes, ...declared.filter((id) => !nodes.includes(id))];
  const graph = new Map(declared.map((id) => [id, [...dependencies[id]]]));
  for (const id of nodes) if (!graph.has(id)) throw new Error(`Missing declaration for ${id}`);
  for (const [id, required] of graph) {
    for (const dependency of required)
      if (!graph.has(dependency))
        throw new Error(`Missing declaration for ${dependency}, required by ${id}`);
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const visit = (id) => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      throw new Error(`Cycle: ${[...stack.slice(start), id].join(" -> ")}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of graph.get(id)) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of order) visit(id);

  const remaining = new Set(order);
  const output = [];
  while (remaining.size > 0) {
    const eligible = order.find(
      (id) => remaining.has(id) && graph.get(id).every((dependency) => !remaining.has(dependency)),
    );
    if (eligible === undefined) throw new Error("Unresolved dependency cycle");
    remaining.delete(eligible);
    output.push(eligible);
  }
  return output;
}
