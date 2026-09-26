import { planRelayAction } from "./decision-engine.js";
import type { MatterEndpointReference } from "./matter-model.js";

/** Ignore relay reads that started before (or right after) our last command reached the device. */
const OBSERVATION_GRACE_MS = 2_000;

export interface RelayDemand {
  heat: boolean;
  retryEnabled: boolean;
  retryDelayMs: number;
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
  private cutOutSince?: number;
  private lastReason?: string;
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
    }

    const demanding = [...this.demands.values()].filter((entry) => entry.heat);
    const retrying = demanding.filter((entry) => entry.retryEnabled);
    const plan = planRelayAction({
      demand: demanding.length > 0,
      observedOn: this.observedOn,
      commandedOn: this.commandedOn,
      cutOutSince: this.cutOutSince,
      retryEnabled: retrying.length > 0,
      retryDelayMs: retrying.length ? Math.min(...retrying.map((entry) => entry.retryDelayMs)) : 0,
      now: this.now(),
    });

    this.cutOutSince = plan.cutOutSince;
    if (plan.reason !== this.lastReason) {
      if (plan.reason === "cut-out-no-retry") {
        this.log.warn(`${this.label} switched off by itself while heating is needed. Relay retry is disabled, leaving it off.`);
      } else if (plan.reason === "cut-out-wait") {
        this.log.warn(`${this.label} switched off by itself while heating is needed. Retrying later.`);
      }
      this.lastReason = plan.reason;
    }

    if (plan.action === "none") {
      return;
    }

    const enable = plan.action === "on";
    const message = `Turning ${this.label} ${enable ? "on" : "off"}${plan.reason === "cut-out-retry" ? " again after a cut-out" : ""}.`;
    if (this.failedAction === enable) {
      this.log.debug(`${message} (retry)`);
    } else {
      this.log.info(message);
    }

    try {
      await this.switcher.setSwitchState(this.reference, enable);
    } catch (error) {
      this.failedAction = enable;
      throw error;
    }

    this.failedAction = undefined;
    this.commandedOn = enable;
    this.observedOn = enable;
    this.lastCommandAt = this.now();
    this.cutOutSince = undefined;
    this.lastReason = undefined;
  }
}
