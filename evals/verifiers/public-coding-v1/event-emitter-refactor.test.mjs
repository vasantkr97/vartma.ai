import assert from "node:assert/strict";
import { EventBus } from "../event-bus.mjs";

const bus = new EventBus();
const calls = [];
const first = (value) => calls.push(`first:${value}`);
const second = (value) => calls.push(`second:${value}`);
const unsubscribe = bus.on("data", first);
bus.on("data", second);
assert.equal(bus.emit("data", 1), 2);
assert.equal(bus.off("data", first), true);
assert.equal(bus.emit("data", 2), 1);
assert.equal(unsubscribe(), false);
assert.deepEqual(calls, ["first:1", "second:1", "second:2"]);

let onceCalls = 0;
const once = () => {
  onceCalls += 1;
};
const cancelOnce = bus.once("once", once);
assert.equal(cancelOnce(), true);
assert.equal(bus.emit("once"), 0);
bus.once("once", once);
assert.equal(bus.emit("once"), 1);
assert.equal(bus.emit("once"), 0);
assert.equal(onceCalls, 1);
assert.throws(() => bus.on("x", null), TypeError);
