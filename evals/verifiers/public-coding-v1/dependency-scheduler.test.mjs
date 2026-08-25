import assert from "node:assert/strict";
import { runSchedule, ScheduleError } from "../scheduler.mjs";

let active = 0;
let peak = 0;
const started = [];
const task = (id, dependsOn, delay, value = id) => ({
  id,
  dependsOn,
  run: async () => {
    started.push(id);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return value;
  },
});
const tasks = [task("a", [], 30), task("b", [], 20), task("c", ["a"], 1), task("d", ["a", "b"], 1)];
const results = await runSchedule(tasks, { concurrency: 2 });
assert.ok(peak === 2, `peak=${peak}`);
assert.deepEqual(
  [...results],
  [
    ["a", "a"],
    ["b", "b"],
    ["c", "c"],
    ["d", "d"],
  ],
);
assert.ok(started.indexOf("c") > started.indexOf("a"));
await assert.rejects(
  runSchedule([{ id: "x", dependsOn: ["missing"], run() {} }]),
  /Missing dependency/u,
);
await assert.rejects(
  runSchedule([
    { id: "x", dependsOn: ["y"], run() {} },
    { id: "y", dependsOn: ["x"], run() {} },
  ]),
  /x.*y.*x|y.*x.*y/u,
);

const independentRan = [];
await assert.rejects(
  runSchedule(
    [
      {
        id: "fail",
        dependsOn: [],
        async run() {
          throw new Error("boom");
        },
      },
      {
        id: "blocked",
        dependsOn: ["fail"],
        async run() {
          throw new Error("must not run");
        },
      },
      {
        id: "transitive",
        dependsOn: ["blocked"],
        async run() {
          throw new Error("must not run");
        },
      },
      {
        id: "independent",
        dependsOn: [],
        async run() {
          independentRan.push("yes");
          return 7;
        },
      },
    ],
    { concurrency: 2 },
  ),
  (error) => {
    assert.ok(error instanceof ScheduleError);
    assert.deepEqual([...error.results], [["independent", 7]]);
    assert.deepEqual([...error.failures.keys()], ["fail"]);
    assert.deepEqual([...error.skipped], ["blocked", "transitive"]);
    return true;
  },
);
assert.deepEqual(independentRan, ["yes"]);
