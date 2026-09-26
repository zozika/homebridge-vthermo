import test from "node:test";
import assert from "node:assert/strict";

import { RelayController } from "../dist/relay-controller.js";

const reference = {
  nodeId: "hub",
  deviceIdentifier: "hub",
  endpointId: 18,
  clusterType: "onOff",
  endpointName: "Boiler Relay",
  deviceName: "Boiler Relay",
  nodeName: "Hub",
};

function makeRelay() {
  let now = 100_000;
  const commands = [];
  const logs = [];
  const relay = new RelayController(
    reference,
    { setSwitchState: async (_reference, enabled) => { commands.push(enabled); } },
    { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: () => undefined },
    () => now,
  );

  return { relay, commands, logs, advance: (ms) => { now += ms; }, now: () => now };
}

const heat = { heat: true, retryEnabled: false, retryDelayMs: 0 };
const idle = { heat: false, retryEnabled: false, retryDelayMs: 0 };

test("a shared relay stays on while any thermostat needs heat", async () => {
  const { relay, commands } = makeRelay();
  relay.register("a");
  relay.register("b");

  await relay.update("a", heat);
  await relay.update("b", idle);
  assert.deepEqual(commands, [true]);
  assert.equal(relay.isOn, true);

  await relay.update("a", idle);
  assert.deepEqual(commands, [true, false]);
});

test("ignores relay reads that started before the last command", async () => {
  const { relay, commands, now } = makeRelay();
  relay.register("a");
  const staleRead = { on: false, at: now() - 1 };

  await relay.update("a", heat);
  await relay.update("a", heat, staleRead);
  assert.deepEqual(commands, [true]);
  assert.equal(relay.isOn, true);
});

test("detects a cut-out and retries after the delay", async () => {
  const { relay, commands, advance, now } = makeRelay();
  const retry = { heat: true, retryEnabled: true, retryDelayMs: 60_000 };
  relay.register("a");

  await relay.update("a", retry);
  advance(30_000);
  await relay.update("a", retry, { on: false, at: now() });
  assert.deepEqual(commands, [true]);

  advance(59_000);
  await relay.update("a", retry, { on: false, at: now() });
  assert.deepEqual(commands, [true]);

  advance(1_000);
  await relay.update("a", retry, { on: false, at: now() });
  assert.deepEqual(commands, [true, true]);
});

test("a failed command is reported and retried on the next update", async () => {
  let fail = true;
  const commands = [];
  const relay = new RelayController(
    reference,
    { setSwitchState: async (_reference, enabled) => { if (fail) throw new Error("unreachable"); commands.push(enabled); } },
    { info: () => undefined, warn: () => undefined, debug: () => undefined },
  );
  relay.register("a");

  await assert.rejects(relay.update("a", heat), /unreachable/);
  assert.equal(relay.isOn, undefined);
  fail = false;
  await relay.update("a", heat);
  assert.deepEqual(commands, [true]);
});

test("a command that keeps failing is logged once at info level", async () => {
  const infos = [];
  const relay = new RelayController(
    reference,
    { setSwitchState: async () => { throw new Error("unreachable"); } },
    { info: (m) => infos.push(m), warn: () => undefined, debug: () => undefined },
  );
  relay.register("a");

  await relay.update("a", idle).catch(() => undefined);
  await relay.update("a", idle).catch(() => undefined);
  await relay.update("a", idle).catch(() => undefined);
  assert.equal(infos.length, 1);
});

test("a shared relay uses the strictest minimum on-time", async () => {
  const { relay, commands, advance } = makeRelay();
  relay.register("a");
  relay.register("b");

  // Unknown state at start: the first idle request switches the relay off once.
  await relay.update("b", { ...idle, minOnMs: 300_000 });
  advance(1_000);
  await relay.update("a", heat);
  assert.deepEqual(commands, [false, true]);
  advance(60_000);
  await relay.update("a", idle);
  assert.deepEqual(commands, [false, true]);
  assert.equal(relay.waitingReason, "min-on-wait");
  advance(240_000);
  await relay.update("a", idle);
  assert.deepEqual(commands, [false, true, false]);
});

test("the startup sync of an unknown relay does not start the minimum off-time", async () => {
  const { relay, commands, advance } = makeRelay();
  relay.register("a");
  const demand = { ...idle, minOffMs: 600_000 };
  await relay.update("a", demand);
  advance(1_000);
  await relay.update("a", { ...demand, heat: true });
  assert.deepEqual(commands, [false, true]);
});
