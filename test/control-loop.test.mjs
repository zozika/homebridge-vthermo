import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateTemperatures,
  computeDemand,
  computeHeatingDecision,
  planRelayAction,
} from "../dist/decision-engine.js";

test("turns heating on below the lower hysteresis bound", () => {
  const result = computeHeatingDecision({
    mode: "HEAT",
    currentTemperature: 20.7,
    targetTemperature: 21,
    hysteresis: 0.4,
    currentlyHeating: false,
  });

  assert.equal(result.shouldHeat, true);
  assert.equal(result.lowerBound, 20.8);
  assert.equal(result.upperBound, 21.2);
});

test("keeps heating on inside the hysteresis window", () => {
  const result = computeHeatingDecision({
    mode: "HEAT",
    currentTemperature: 21.1,
    targetTemperature: 21,
    hysteresis: 0.4,
    currentlyHeating: true,
  });

  assert.equal(result.shouldHeat, true);
});

test("turns heating off above the upper hysteresis bound", () => {
  const result = computeHeatingDecision({
    mode: "HEAT",
    currentTemperature: 21.2,
    targetTemperature: 21,
    hysteresis: 0.4,
    currentlyHeating: true,
  });

  assert.equal(result.shouldHeat, false);
});

test("always turns heating off in OFF mode", () => {
  const result = computeHeatingDecision({
    mode: "OFF",
    currentTemperature: 18,
    targetTemperature: 24,
    hysteresis: 0.8,
    currentlyHeating: true,
  });

  assert.equal(result.shouldHeat, false);
});

test("aggregates temperatures using average", () => {
  assert.equal(aggregateTemperatures([20, 21, 22], "average"), 21);
});

test("aggregates temperatures using minimum", () => {
  assert.equal(aggregateTemperatures([20, 21, 22], "minimum"), 20);
});

test("aggregates temperatures using maximum", () => {
  assert.equal(aggregateTemperatures([20, 21, 22], "maximum"), 22);
});

const base = { retryEnabled: false, retryDelayMs: 60_000, now: 1_000_000 };

test("relay: turns on when heat is needed and relay is off", () => {
  const plan = planRelayAction({ ...base, demand: true, observedOn: false });
  assert.equal(plan.action, "on");
});

test("relay: turns off when no heat is needed and the state is unknown", () => {
  const plan = planRelayAction({ ...base, demand: false });
  assert.equal(plan.action, "off");
});

test("relay: nothing to do when already in the requested state", () => {
  assert.equal(planRelayAction({ ...base, demand: true, observedOn: true, commandedOn: true }).action, "none");
  assert.equal(planRelayAction({ ...base, demand: false, observedOn: false, commandedOn: false }).action, "none");
});

test("relay: cut-out without retry leaves the relay off", () => {
  const plan = planRelayAction({ ...base, demand: true, observedOn: false, commandedOn: true });
  assert.equal(plan.action, "none");
  assert.equal(plan.reason, "cut-out-no-retry");
});

test("relay: cut-out with retry waits for the delay, then switches on again", () => {
  const first = planRelayAction({ ...base, retryEnabled: true, demand: true, observedOn: false, commandedOn: true });
  assert.equal(first.action, "none");
  assert.equal(first.reason, "cut-out-wait");
  assert.equal(first.cutOutSince, base.now);

  const early = planRelayAction({
    ...base, retryEnabled: true, demand: true, observedOn: false, commandedOn: true,
    cutOutSince: first.cutOutSince, now: base.now + 30_000,
  });
  assert.equal(early.action, "none");

  const late = planRelayAction({
    ...base, retryEnabled: true, demand: true, observedOn: false, commandedOn: true,
    cutOutSince: first.cutOutSince, now: base.now + 60_000,
  });
  assert.equal(late.action, "on");
  assert.equal(late.reason, "cut-out-retry");
});

test("relay: minimum on-time keeps a relay we switched on", () => {
  const plan = planRelayAction({ ...base, demand: false, observedOn: true, commandedOn: true, minOnMs: 300_000, lastSwitchAt: base.now - 60_000 });
  assert.equal(plan.action, "none");
  assert.equal(plan.reason, "min-on-wait");
  assert.equal(plan.waitMs, 240_000);
  assert.equal(planRelayAction({ ...base, demand: false, observedOn: true, commandedOn: true, minOnMs: 300_000, lastSwitchAt: base.now - 300_000 }).action, "off");
});

test("relay: minimum on-time does not protect an unknown or foreign on-state", () => {
  assert.equal(planRelayAction({ ...base, demand: false, observedOn: true, commandedOn: false, minOnMs: 300_000, lastSwitchAt: base.now }).action, "off");
});

test("relay: minimum off-time delays switching on again", () => {
  const plan = planRelayAction({ ...base, demand: true, observedOn: false, commandedOn: false, minOffMs: 120_000, lastSwitchAt: base.now - 30_000 });
  assert.equal(plan.reason, "min-off-wait");
  assert.equal(planRelayAction({ ...base, demand: true, observedOn: false, commandedOn: false, minOffMs: 120_000, lastSwitchAt: base.now - 120_000 }).action, "on");
});

const demandBase = {
  heatMode: true, windowOpen: false, temperatureAvailable: true, currentTemperature: 20, targetTemperature: 21,
  hysteresis: 0.5, frostProtectionTemperature: 0, currentlyHeating: false,
};

test("demand: heats below target, idles above", () => {
  assert.deepEqual(computeDemand(demandBase), { heat: true, reason: "heat" });
  assert.deepEqual(computeDemand({ ...demandBase, currentTemperature: 22 }), { heat: false, reason: "idle" });
});

test("demand: window and OFF mode stop heating unless frost protection kicks in", () => {
  assert.equal(computeDemand({ ...demandBase, windowOpen: true }).reason, "window");
  assert.equal(computeDemand({ ...demandBase, heatMode: false }).reason, "off");
  assert.deepEqual(computeDemand({ ...demandBase, heatMode: false, currentTemperature: 4, frostProtectionTemperature: 6 }), { heat: true, reason: "frost" });
  assert.deepEqual(computeDemand({ ...demandBase, windowOpen: true, currentTemperature: 4, frostProtectionTemperature: 6 }), { heat: true, reason: "frost" });
  assert.equal(computeDemand({ ...demandBase, heatMode: false, currentTemperature: 7, frostProtectionTemperature: 6 }).reason, "off");
});

test("demand: never heats without a temperature", () => {
  assert.deepEqual(computeDemand({ ...demandBase, temperatureAvailable: false, frostProtectionTemperature: 30 }), { heat: false, reason: "no-temperature" });
});
