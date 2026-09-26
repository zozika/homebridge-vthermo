import test from "node:test";
import assert from "node:assert/strict";

import { NodeGuard, NodeUnavailableError, OperationTimeoutError } from "../dist/node-guard.js";

function makeGuard(overrides = {}) {
  let now = 0;
  const events = [];
  const guard = new NodeGuard({
    timeoutMs: 50,
    baseBackoffMs: 1_000,
    maxBackoffMs: 4_000,
    now: () => now,
    onStateChange: (nodeId, online) => events.push(`${nodeId}:${online ? "up" : "down"}`),
    ...overrides,
  });

  return { guard, events, advance: (ms) => { now += ms; } };
}

test("runs operations for the same node one after another", async () => {
  const { guard } = makeGuard();
  const order = [];
  let active = 0;
  let maxActive = 0;

  const work = (label, delay) => guard.run("n1", label, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    order.push(label);
    active -= 1;
  });

  await Promise.all([work("a", 10), work("b", 1), work("c", 1)]);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(maxActive, 1);
});

test("times out a hanging operation and then fails fast during backoff", async () => {
  const { guard, events, advance } = makeGuard();

  await assert.rejects(guard.run("n1", "hang", () => new Promise(() => undefined)), OperationTimeoutError);
  assert.deepEqual(events, ["n1:down"]);

  let called = false;
  await assert.rejects(guard.run("n1", "blocked", async () => { called = true; }), NodeUnavailableError);
  assert.equal(called, false);

  advance(1_000);
  await guard.run("n1", "recovered", async () => "ok");
  assert.deepEqual(events, ["n1:down", "n1:up"]);
  assert.equal(guard.isBlocked("n1"), false);
});

test("backoff grows and is capped", async () => {
  const { guard, advance } = makeGuard();
  const fail = () => guard.run("n1", "fail", async () => { throw new Error("Operation timed out"); }).catch(() => undefined);

  await fail();
  assert.equal(guard.getHealth("n1").blockedUntil, 1_000);
  advance(1_000);
  await fail();
  assert.equal(guard.getHealth("n1").blockedUntil, 1_000 + 2_000);
  advance(2_000);
  await fail();
  advance(4_000);
  await fail();
  assert.equal(guard.getHealth("n1").blockedUntil - 7_000, 4_000);
});

test("protocol errors do not open the circuit", async () => {
  const { guard } = makeGuard();
  await assert.rejects(guard.run("n1", "bad attribute", async () => { throw new Error("Unsupported attribute"); }));
  assert.equal(guard.isBlocked("n1"), false);
});

test("different nodes do not block each other", async () => {
  const { guard } = makeGuard();
  await assert.rejects(guard.run("n1", "hang", () => new Promise(() => undefined)));
  assert.equal(await guard.run("n2", "ok", async () => 42), 42);
});
