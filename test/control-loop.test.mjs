import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateTemperatures,
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
