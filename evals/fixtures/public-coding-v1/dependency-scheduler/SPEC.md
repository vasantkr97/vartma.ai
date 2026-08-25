# Dependency scheduler

`runSchedule(tasks, {concurrency})` receives unique `{id, dependsOn, run}` tasks. Validate positive
concurrency, duplicate IDs, missing dependencies, and cycles before running anything. Start every
eligible task up to the limit and preserve input order in the returned `Map`. On failure, continue
independent work but never start direct or transitive dependents of a failed task. After settling,
throw `ScheduleError` exposing ordered `results`, `failures`, and `skipped` collections.
