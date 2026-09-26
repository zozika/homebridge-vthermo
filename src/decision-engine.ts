export interface HeatingDecisionInput {
  mode: "OFF" | "HEAT";
  currentTemperature: number;
  targetTemperature: number;
  hysteresis: number;
  currentlyHeating: boolean;
}

export interface HeatingDecisionResult {
  shouldHeat: boolean;
  lowerBound: number;
  upperBound: number;
}

export type TemperatureAggregationMode = "average" | "minimum" | "maximum";

export function computeHeatingDecision(input: HeatingDecisionInput): HeatingDecisionResult {
  if (input.mode === "OFF") {
    return {
      shouldHeat: false,
      lowerBound: input.targetTemperature,
      upperBound: input.targetTemperature,
    };
  }

  const safeHysteresis = Math.max(input.hysteresis, 0.1);
  const halfBand = safeHysteresis / 2;
  const lowerBound = input.targetTemperature - halfBand;
  const upperBound = input.targetTemperature + halfBand;

  if (input.currentlyHeating) {
    return {
      shouldHeat: input.currentTemperature < upperBound,
      lowerBound,
      upperBound,
    };
  }

  return {
    shouldHeat: input.currentTemperature <= lowerBound,
    lowerBound,
    upperBound,
  };
}

export function aggregateTemperatures(values: number[], mode: TemperatureAggregationMode): number {
  if (!values.length) {
    throw new Error("At least one temperature value is required.");
  }

  if (mode === "minimum") {
    return Math.min(...values);
  }

  if (mode === "maximum") {
    return Math.max(...values);
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

export type RelayAction = "on" | "off" | "none";

export interface RelayPlanInput {
  /** Whether any thermostat using this relay currently asks for heat. */
  demand: boolean;
  /** State read from the relay in this cycle, if the read succeeded. */
  observedOn?: boolean;
  /** Last command we successfully sent, if any. */
  commandedOn?: boolean;
  /** When the relay was first seen off although we had switched it on. */
  cutOutSince?: number;
  retryEnabled: boolean;
  retryDelayMs: number;
  now: number;
}

export interface RelayPlan {
  action: RelayAction;
  cutOutSince?: number;
  reason: "in-sync" | "turn-on" | "turn-off" | "cut-out-wait" | "cut-out-retry" | "cut-out-no-retry";
}

/**
 * Decides what to send to the relay.
 *
 * A "cut-out" is when we switched the relay on, but it reports off afterwards (for example a
 * boiler/plug protection switched it off). With retry enabled we wait `retryDelayMs` from the
 * moment the cut-out was first seen and then switch it on again; without retry we leave it off
 * until the demand goes away and comes back.
 */
export function planRelayAction(input: RelayPlanInput): RelayPlan {
  const relayOn = input.observedOn ?? input.commandedOn;

  if (!input.demand) {
    return relayOn === false
      ? { action: "none", reason: "in-sync" }
      : { action: "off", reason: "turn-off" };
  }

  if (relayOn === true) {
    return { action: "none", reason: "in-sync" };
  }

  if (input.commandedOn !== true) {
    return { action: "on", reason: "turn-on" };
  }

  const cutOutSince = input.cutOutSince ?? input.now;
  if (!input.retryEnabled) {
    return { action: "none", cutOutSince, reason: "cut-out-no-retry" };
  }

  if (input.now - cutOutSince >= input.retryDelayMs) {
    return { action: "on", reason: "cut-out-retry" };
  }

  return { action: "none", cutOutSince, reason: "cut-out-wait" };
}
