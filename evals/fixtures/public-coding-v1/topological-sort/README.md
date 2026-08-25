# Stable topological sort

`stableTopologicalSort(nodes, dependencies)` accepts preferred node IDs and an object whose keys
declare every node and whose values list dependencies. Declaration-only dependency nodes are
included. References without a declaration are errors. Return all IDs in dependency order,
preserving preferred input order and then declaration order whenever multiple nodes are eligible.
Duplicate preferred IDs are invalid. Cycles must throw an error containing a concrete cycle path.
