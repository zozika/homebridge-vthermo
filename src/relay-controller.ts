import { MAX_UNCONFIRMED_ON_ATTEMPTS, planRelayAction } from "./decision-engine.js";
import type { MatterEndpointReference } from "./matter-model.js";

/** Ignore relay reads that started before (or right after) our last command reached the device. */
const OBSERVATION_GRACE_MS = 2_000;

export interface RelayDemand {
  heat: boolean;
  retryEnabled: boolean;
  retryDelayMs: number;
  minOnMs?: number;
  minOffMs?: number;
}

export interface RelayObservation {
  on: boolean;
  /** When the read that produced this value was started. */
  at: number;
}

export interface RelaySwitcher {
  setSwitchState(reference: MatterEndpointReference, enabled: boolean): Promise<void>;
}

export interface RelayLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/**
 * Owns one physical relay. Several thermostats may share a relay (e.g. one boiler); the relay is
 * on while any of them asks for heat, so they never switch it back and forth against each other.
 */
export class RelayController {
  private readonly demands = new Map<string, RelayDemand>();
  private commandedOn?: boolean;
  private observedOn?: boolean;
  private lastCommandAt = 0;
  /** Last switch from a known state; boiler protection timers count from here. */
  private lastSwitchAt?: number;
  private cutOutSince?: number;
  private lastReason?: string;
  /** Whether a read confirmed the relay on after our last "on" command (undefined = no such command). */
  private confirmedOn?: boolean;
  private unconfirmedAttempts = 0;
  /** Action whose last attempt failed; repeats are logged quietly until it succeeds. */
  private failedAction?: boolean;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly reference: MatterEndpointReference,
    private readonly switcher: RelaySwitcher,
    private readonly log: RelayLogger,
    private readonly now: () => number = Date.now,
  ) {}

  get label(): string {
    return this.reference.endpointName;
  }

  /** Best known relay state: last fresh reading, otherwise the last command we sent. */
  get isOn(): boolean | undefined {
    return this.observedOn ?? this.commandedOn;
  }

  get thermostatCount(): number {
    return this.demands.size;
  }

  register(thermostatId: string): void {
    if (!this.demands.has(thermostatId)) {
      this.demands.set(thermostatId, { heat: false, retryEnabled: false, retryDelayMs: 0 });
    }
  }

  /** Why the relay is not following the demand right now, if it is waiting (for the status page). */
  get waitingReason(): string | undefined {
    if (this.lastReason === "cut-out-no-retry" && this.confirmedOn === false) {
      return "not-confirmed";
    }
    return this.lastReason === "min-on-wait" || this.lastReason === "min-off-wait"
      || this.lastReason === "cut-out-wait" || this.lastReason === "cut-out-no-retry"
      ? this.lastReason
      : undefined;
  }

  /** Records a thermostat's demand and brings the relay in line. Calls are serialized. */
  update(thermostatId: string, demand: RelayDemand, observation?: RelayObservation): Promise<void> {
    const run = this.chain.catch(() => undefined).then(() => this.apply(thermostatId, demand, observation));
    this.chain = run;
    return run;
  }

  private async apply(thermostatId: string, demand: RelayDemand, observation?: RelayObservation): Promise<void> {
    this.demands.set(thermostatId, demand);

    if (observation && observation.at >= this.lastCommandAt + OBSERVATION_GRACE_MS) {
      if (this.observedOn !== undefined && this.observedOn !== observation.on) {
        this.log.debug(`${this.label} reported ${observation.on ? "on" : "off"} via Matter.`);
      }
      this.observedOn = observation.on;
      if (observation.on && this.commandedOn === true) {
        this.confirmedOn = true;
        this.unconfirmedAttempts = 0;
      }
    }

    const all = [...this.demands.values()];
    const demanding = all.filter((entry) => entry.heat);
    const retrying = demanding.filter((entry) => entry.retryEnabled);
    const plan = planRelayAction({
      // A shared relay protects the boiler with the strictest setting of its thermostats.
      minOnMs: Math.max(0, ...all.map((entry) => entry.minOnMs ?? 0)),
      minOffMs: Math.max(0, ...all.map((entry) => entry.minOffMs ?? 0)),
      lastSwitchAt: this.lastSwitchAt,
      demand: demanding.length > 0,
      observedOn: this.observedOn,
      commandedOn: this.commandedOn,
      cutOutSince: this.cutOutSince,
      retryEnabled: retrying.length > 0,
      retryDelayMs: retrying.length ? Math.min(...retrying.map((entry) => entry.retryDelayMs)) : 0,
      confirmedOn: this.confirmedOn,
      unconfirmedAttempts: this.unconfirmedAttempts,
      now: this.now(),
    });

    this.cutOutSince = plan.cutOutSince;
    if (plan.reason !== this.lastReason) {
      if (plan.reason === "cut-out-no-retry" && this.confirmedOn === false) {
        this.log.warn(`${this.label} did not switch on after ${this.unconfirmedAttempts} commands although the hub accepted them. `
          + "Check the device in its own app (offline, child lock, power-on behaviour). Enable relay retry to keep trying.");
      } else if (plan.reason === "cut-out-no-retry") {
        this.log.warn(`${this.label} switched off by itself while heating is needed. Relay retry is disabled, leaving it off.`);
      } else if (plan.reason === "cut-out-wait") {
        this.log.warn(`${this.label} switched off by itself while heating is needed. Retrying later.`);
      } else if (plan.reason === "min-on-wait" || plan.reason === "min-off-wait") {
        this.log.debug(`${this.label}: boiler protection, keeping it ${plan.reason === "min-on-wait" ? "on" : "off"} `
          + `for another ${Math.ceil((plan.waitMs ?? 0) / 1000)}s.`);
      }
      this.lastReason = plan.reason;
    }

    if (plan.action === "none") {
      return;
    }

    const enable = plan.action === "on";
    const suffix = plan.reason === "cut-out-retry"
      ? " again after a cut-out"
      : plan.reason === "not-confirmed-retry"
        ? ` again: it did not report on after the last command (${this.unconfirmedAttempts + 1}/${MAX_UNCONFIRMED_ON_ATTEMPTS})`
        : "";
    const message = `Turning ${this.label} ${enable ? "on" : "off"}${suffix}.`;
    if (this.failedAction === enable) {
      this.log.debug(`${message} (retry)`);
    } else {
      this.log.info(message);
    }

    const stateWasKnown = this.isOn !== undefined;
    try {
      await this.switcher.setSwitchState(this.reference, enable);
    } catch (error) {
      this.failedAction = enable;
      throw error;
    }

    this.failedAction = undefined;
    if (enable) {
      this.unconfirmedAttempts = plan.reason === "not-confirmed-retry" ? this.unconfirmedAttempts + 1 : 1;
      this.confirmedOn = false;
    } else {
      this.unconfirmedAttempts = 0;
      this.confirmedOn = undefined;
    }
    this.commandedOn = enable;
    this.observedOn = enable;
    this.lastCommandAt = this.now();
    // Syncing an unknown state at startup is not a real switch; do not start the protection timers.
    this.lastSwitchAt = stateWasKnown ? this.lastCommandAt : undefined;
    this.cutOutSince = undefined;
    this.lastReason = undefined;
  }
}
