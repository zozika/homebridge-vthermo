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

export type DemandReason = "heat" | "frost" | "idle" | "off" | "window" | "no-temperature";

export interface DemandInput {
  heatMode: boolean;
  windowOpen: boolean;
  temperatureAvailable: boolean;
  currentTemperature: number;
  targetTemperature: number;
  hysteresis: number;
  /** 0 or undefined disables frost protection. */
  frostProtectionTemperature?: number;
  currentlyHeating: boolean;
}

/**
 * Whether this thermostat asks for heat. Frost protection overrides OFF mode and open windows:
 * it keeps the room above the frost temperature so pipes and radiators cannot freeze.
 */
export function computeDemand(input: DemandInput): { heat: boolean; reason: DemandReason } {
  if (!input.temperatureAvailable) {
    return { heat: false, reason: "no-temperature" };
  }

  const frost = input.frostProtectionTemperature ?? 0;
  if (frost > 0 && (!input.heatMode || input.windowOpen)) {
    const frostDecision = computeHeatingDecision({
      mode: "HEAT",
      currentTemperature: input.currentTemperature,
      targetTemperature: frost,
      hysteresis: input.hysteresis,
      currentlyHeating: input.currentlyHeating,
    });
    if (frostDecision.shouldHeat) {
      return { heat: true, reason: "frost" };
    }
  }

  if (!input.heatMode) {
    return { heat: false, reason: "off" };
  }

  if (input.windowOpen) {
    return { heat: false, reason: "window" };
  }

  const decision = computeHeatingDecision({
    mode: "HEAT",
    currentTemperature: input.currentTemperature,
    targetTemperature: input.targetTemperature,
    hysteresis: input.hysteresis,
    currentlyHeating: input.currentlyHeating,
  });

  return decision.shouldHeat ? { heat: true, reason: "heat" } : { heat: false, reason: "idle" };
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
  /** Boiler protection: minimum time the relay stays on / off after we switched it. */
  minOnMs?: number;
  minOffMs?: number;
  /** When we last successfully switched the relay. */
  lastSwitchAt?: number;
  /**
   * Whether a read has confirmed the relay on since our last "on" command. Bridges such as the
   * Aqara hub accept a command although the Zigbee relay behind them did not switch; that is a
   * failed command, not a cut-out, and is simply sent again.
   */
  confirmedOn?: boolean;
  /** "On" commands sent since the relay was last confirmed on. */
  unconfirmedAttempts?: number;
  now: number;
}

/** Total "on" commands (first + repeats) for a relay that does not report on, before giving up. */
export const MAX_UNCONFIRMED_ON_ATTEMPTS = 3;

export interface RelayPlan {
  action: RelayAction;
  cutOutSince?: number;
  reason: "in-sync" | "turn-on" | "turn-off" | "cut-out-wait" | "cut-out-retry" | "cut-out-no-retry" | "min-on-wait" | "min-off-wait"
    | "not-confirmed-retry";
  /** For the min-on/off waits: how long until the relay may switch. */
  waitMs?: number;
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
  const sinceSwitch = input.lastSwitchAt === undefined ? Number.POSITIVE_INFINITY : input.now - input.lastSwitchAt;

  if (!input.demand) {
    if (relayOn === false) {
      return { action: "none", reason: "in-sync" };
    }

    // Only protect a run we started ourselves; an unknown or foreign "on" is switched off at once.
    const minOnMs = input.minOnMs ?? 0;
    if (input.commandedOn === true && relayOn === true && sinceSwitch < minOnMs) {
      return { action: "none", reason: "min-on-wait", waitMs: minOnMs - sinceSwitch };
    }

    return { action: "off", reason: "turn-off" };
  }

  if (relayOn === true) {
    return { action: "none", reason: "in-sync" };
  }

  if (input.commandedOn !== true) {
    const minOffMs = input.minOffMs ?? 0;
    if (input.commandedOn === false && sinceSwitch < minOffMs) {
      return { action: "none", reason: "min-off-wait", waitMs: minOffMs - sinceSwitch };
    }

    return { action: "on", reason: "turn-on" };
  }

  // We switched it on but it never reported on: the command did not take effect. Send it again.
  if (input.confirmedOn === false && (input.unconfirmedAttempts ?? 0) < MAX_UNCONFIRMED_ON_ATTEMPTS) {
    return { action: "on", reason: "not-confirmed-retry" };
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
