import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";

import type { ResolvedThermostatConfig } from "./config.js";
import { aggregateTemperatures, computeDemand, type DemandReason } from "./decision-engine.js";
import { referenceKey } from "./matter-model.js";
import type { VthermoPlatform } from "./platform.js";
import type { RelayController, RelayObservation } from "./relay-controller.js";
import { PLUGIN_VERSION } from "./settings.js";

interface PersistedState {
  targetTemperature?: number;
  targetHeatingCoolingState?: number;
  temperatureDisplayUnits?: number;
  lastTemperature?: number;
}

/** First cycle shortly after start, so the Matter controller has a moment to come online. */
const FIRST_CYCLE_DELAY_MS = 3_000;
/** While no temperature has been read yet, retry faster than the normal check interval. */
const STARTUP_RETRY_MS = 15_000;
/** How long a last good reading may be reused when a sensor temporarily does not answer. */
const STALE_READING_MS = 10 * 60_000;

export interface ThermostatStatus {
  id: string;
  name: string;
  mode: "HEAT" | "OFF";
  currentTemperature?: number;
  targetTemperature: number;
  humidity?: number;
  heating: boolean;
  demandReason: DemandReason;
  relayName: string;
  relayOn?: boolean;
  relayWaiting?: string;
  windowOpen: boolean;
  fault?: string;
  warning?: string;
  lastReadingAt?: number;
  lastCycleAt?: number;
  sources: Array<{ name: string; kind: "temperature" | "humidity" | "contact"; value?: number | boolean; offset?: number; error?: string }>;
}

export class VthermoAccessory {
  private readonly service: Service;
  private readonly hap;

  private cycleTimer?: NodeJS.Timeout;
  private cycleRunning = false;
  private cyclePending = false;
  private stopped = false;

  private currentTemperature: number;
  private lastTemperatureAt?: number;
  private targetTemperature: number;
  private targetHeatingCoolingState: number;
  private temperatureDisplayUnits: number;
  private heatDemand = false;
  private demandReason: DemandReason = "idle";
  private windowOpen = false;
  private humidity?: number;
  private lastCycleAt?: number;
  private sourceStates: ThermostatStatus["sources"] = [];
  private readonly contactStates = new Map<string, { open: boolean; at: number }>();

  private faultMessage?: string;
  private lastWarning?: string;

  constructor(
    private readonly platform: VthermoPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: ResolvedThermostatConfig,
    private readonly relay: RelayController,
  ) {
    this.hap = this.platform.api.hap;
    const { Characteristic } = this.hap;
    const persisted = (this.accessory.context.persistedState ?? {}) as PersistedState;

    this.currentTemperature = typeof persisted.lastTemperature === "number"
      ? persisted.lastTemperature
      : this.config.defaultTargetTemperature;
    this.targetTemperature = this.clampTarget(
      typeof persisted.targetTemperature === "number" ? persisted.targetTemperature : this.config.defaultTargetTemperature,
    );
    this.targetHeatingCoolingState = persisted.targetHeatingCoolingState === Characteristic.TargetHeatingCoolingState.OFF
      ? Characteristic.TargetHeatingCoolingState.OFF
      : Characteristic.TargetHeatingCoolingState.HEAT;
    this.temperatureDisplayUnits = persisted.temperatureDisplayUnits === Characteristic.TemperatureDisplayUnits.FAHRENHEIT
      ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT
      : Characteristic.TemperatureDisplayUnits.CELSIUS;

    this.accessory.context.config = this.config;
    this.relay.register(this.config.id);

    this.service = this.accessory.getService(this.hap.Service.Thermostat)
      ?? this.accessory.addService(this.hap.Service.Thermostat, this.config.name);

    this.configureAccessoryInformation();
    this.configureThermostatService();
  }

  start(): void {
    this.platform.debug(`[${this.config.name}] control cycle every ${this.config.checkIntervalSeconds}s.`);
    this.scheduleCycle(FIRST_CYCLE_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // HomeKit
  // ---------------------------------------------------------------------------------------------

  private configureAccessoryInformation(): void {
    const { Characteristic, Service } = this.hap;
    const information = this.accessory.getService(Service.AccessoryInformation)
      ?? this.accessory.addService(Service.AccessoryInformation);

    information
      .setCharacteristic(Characteristic.Manufacturer, "palmaiz")
      .setCharacteristic(Characteristic.Model, "Matter Virtual Thermostat")
      .setCharacteristic(Characteristic.SerialNumber, `vthermo-${this.config.id}`)
      .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);
  }

  private configureThermostatService(): void {
    const { Characteristic } = this.hap;

    this.service.setCharacteristic(Characteristic.Name, this.config.name);
    // iOS 16+ shows ConfiguredName instead of Name for non-primary names.
    if (!this.service.testCharacteristic(Characteristic.ConfiguredName)) {
      this.service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    this.service.setCharacteristic(Characteristic.ConfiguredName, this.config.name);
    // StatusFault is not in HAP's optional list for Thermostat; declare it so HAP does not warn.
    if (!this.service.testCharacteristic(Characteristic.StatusFault)) {
      this.service.addOptionalCharacteristic(Characteristic.StatusFault);
    }

    if (this.config.humiditySource) {
      if (!this.service.testCharacteristic(Characteristic.CurrentRelativeHumidity)) {
        this.service.addOptionalCharacteristic(Characteristic.CurrentRelativeHumidity);
      }
      this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .onGet(() => this.humidity ?? 0);
    } else if (this.service.testCharacteristic(Characteristic.CurrentRelativeHumidity)) {
      this.service.removeCharacteristic(this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity));
    }

    // All getters answer from memory. Matter traffic never blocks HomeKit.
    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.currentTemperature);

    this.service.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: this.config.minTargetTemperature,
        maxValue: this.config.maxTargetTemperature,
        minStep: 0.5,
      })
      .onGet(() => this.targetTemperature)
      .onSet((value: CharacteristicValue) => {
        this.targetTemperature = this.clampTarget(Number(value));
        this.persistState();
        this.platform.debug(`[${this.config.name}] target temperature set to ${this.targetTemperature} C.`);
        this.requestCycle();
      });

    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.TargetHeatingCoolingState.OFF,
          Characteristic.TargetHeatingCoolingState.HEAT,
        ],
      })
      .onGet(() => this.targetHeatingCoolingState)
      .onSet((value: CharacteristicValue) => {
        this.targetHeatingCoolingState = Number(value) === Characteristic.TargetHeatingCoolingState.OFF
          ? Characteristic.TargetHeatingCoolingState.OFF
          : Characteristic.TargetHeatingCoolingState.HEAT;
        this.persistState();
        this.platform.debug(`[${this.config.name}] mode set to ${this.modeLabel}.`);
        this.requestCycle();
      });

    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.currentHeatingCoolingState);

    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.temperatureDisplayUnits)
      .onSet((value: CharacteristicValue) => {
        this.temperatureDisplayUnits = Number(value) === Characteristic.TemperatureDisplayUnits.FAHRENHEIT
          ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT
          : Characteristic.TemperatureDisplayUnits.CELSIUS;
        this.persistState();
      });

    this.service.getCharacteristic(Characteristic.StatusFault)
      .onGet(() => this.faultMessage ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT);
  }

  private get currentHeatingCoolingState(): number {
    const { CurrentHeatingCoolingState } = this.hap.Characteristic;
    return this.heatDemand && this.relay.isOn === true ? CurrentHeatingCoolingState.HEAT : CurrentHeatingCoolingState.OFF;
  }

  private get modeLabel(): string {
    return this.targetHeatingCoolingState === this.hap.Characteristic.TargetHeatingCoolingState.OFF ? "OFF" : "HEAT";
  }

  private pushState(): void {
    const { Characteristic } = this.hap;
    this.service.updateCharacteristic(Characteristic.CurrentTemperature, this.currentTemperature);
    if (this.config.humiditySource && this.humidity !== undefined) {
      this.service.updateCharacteristic(Characteristic.CurrentRelativeHumidity, this.humidity);
    }
    this.service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, this.currentHeatingCoolingState);
    this.service.updateCharacteristic(
      Characteristic.StatusFault,
      this.faultMessage ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Control cycle
  // ---------------------------------------------------------------------------------------------

  /** Run a cycle as soon as possible without blocking the caller (HomeKit set handlers). */
  private requestCycle(): void {
    if (this.cycleRunning) {
      this.cyclePending = true;
      return;
    }

    this.scheduleCycle(0);
  }

  private scheduleCycle(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
    }

    this.cycleTimer = setTimeout(() => {
      this.cycleTimer = undefined;
      void this.runCycle();
    }, delayMs);
  }

  private async runCycle(): Promise<void> {
    if (this.cycleRunning || this.stopped) {
      return;
    }

    this.cycleRunning = true;
    try {
      await this.cycle();
    } catch (error) {
      this.setFault(error instanceof Error ? error.message : String(error));
    } finally {
      this.cycleRunning = false;
      this.pushState();

      if (this.cyclePending) {
        this.cyclePending = false;
        this.scheduleCycle(0);
      } else {
        this.scheduleCycle(this.lastTemperatureAt === undefined
          ? Math.min(STARTUP_RETRY_MS, this.config.checkIntervalSeconds * 1000)
          : this.config.checkIntervalSeconds * 1000);
      }
    }
  }

  private async cycle(): Promise<void> {
    const now = Date.now();
    const humiditySource = this.config.humiditySource;
    const references = [
      ...this.config.temperatureSources,
      ...this.config.contactSensors,
      this.config.switchTarget,
      ...(humiditySource ? [humiditySource] : []),
    ];
    const results = await this.platform.controllerClient.readEndpoints(references);
    const problems: string[] = [];
    const sources: ThermostatStatus["sources"] = [];

    // Temperatures: use every source that answered, each with its own calibration offset.
    const temperatures: number[] = [];
    for (const source of this.config.temperatureSources) {
      const result = results.get(referenceKey(source));
      if (result?.ok && typeof result.value === "number") {
        const value = result.value + (source.offset ?? 0);
        temperatures.push(value);
        sources.push({ name: source.endpointName, kind: "temperature", value, offset: source.offset });
      } else {
        const error = result && !result.ok ? result.error : `${source.endpointName}: no value`;
        problems.push(error);
        sources.push({ name: source.endpointName, kind: "temperature", offset: source.offset, error });
      }
    }

    if (humiditySource) {
      const result = results.get(referenceKey(humiditySource));
      if (result?.ok && typeof result.value === "number") {
        this.humidity = Math.min(100, Math.max(0, Math.round(result.value)));
        sources.push({ name: humiditySource.endpointName, kind: "humidity", value: this.humidity });
      } else {
        sources.push({ name: humiditySource.endpointName, kind: "humidity", error: result && !result.ok ? result.error : "no value" });
      }
    }

    let temperatureError: string | undefined;
    if (temperatures.length) {
      this.currentTemperature = Math.round(aggregateTemperatures(temperatures, this.config.temperatureAggregation) * 100) / 100;
      this.lastTemperatureAt = now;
    } else if (this.lastTemperatureAt === undefined || now - this.lastTemperatureAt > STALE_READING_MS) {
      temperatureError = `No temperature source answered. ${problems[0] ?? ""}`.trim();
    }

    // Contact sensors: a sensor that does not answer keeps its last state for a while, then counts as closed.
    let anyOpen = false;
    for (const sensor of this.config.contactSensors) {
      const key = referenceKey(sensor);
      const result = results.get(key);
      if (result?.ok && typeof result.value === "boolean") {
        this.contactStates.set(key, { open: result.value, at: now });
        sources.push({ name: sensor.endpointName, kind: "contact", value: result.value });
      } else {
        const error = result && !result.ok ? result.error : `${sensor.endpointName}: no value`;
        problems.push(error);
        sources.push({ name: sensor.endpointName, kind: "contact", error });
      }

      const state = this.contactStates.get(key);
      if (state && now - state.at <= STALE_READING_MS && state.open) {
        anyOpen = true;
      }
    }

    // Relay state as seen by this read (used to detect cut-outs and manual changes).
    const relayResult = results.get(referenceKey(this.config.switchTarget));
    const observation: RelayObservation | undefined = relayResult?.ok && typeof relayResult.value === "boolean"
      ? { on: relayResult.value, at: now }
      : undefined;

    const demand = computeDemand({
      heatMode: this.targetHeatingCoolingState !== this.hap.Characteristic.TargetHeatingCoolingState.OFF,
      windowOpen: anyOpen,
      temperatureAvailable: temperatureError === undefined,
      currentTemperature: this.currentTemperature,
      targetTemperature: this.targetTemperature,
      hysteresis: this.config.hysteresis,
      frostProtectionTemperature: this.config.frostProtectionTemperature,
      currentlyHeating: this.heatDemand,
    });
    if (demand.reason === "frost" && this.demandReason !== "frost") {
      this.platform.log.warn(`[${this.config.name}] Frost protection: ${this.currentTemperature.toFixed(1)} C is below `
        + `${this.config.frostProtectionTemperature} C, heating although the thermostat is off or a window is open.`);
    }
    this.heatDemand = demand.heat;
    this.demandReason = demand.reason;
    this.windowOpen = anyOpen;
    this.sourceStates = sources;
    this.lastCycleAt = now;

    this.platform.debug(
      `[${this.config.name}] current ${this.currentTemperature.toFixed(2)} C (${temperatures.length}/${this.config.temperatureSources.length} sources), `
      + `target ${this.targetTemperature.toFixed(1)} C, mode ${this.modeLabel}, window ${anyOpen ? "open" : "closed"}, `
      + `relay ${this.relay.isOn === undefined ? "unknown" : this.relay.isOn ? "on" : "off"}, demand ${this.heatDemand ? "heat" : "idle"}.`,
    );

    let relayError: string | undefined;
    try {
      await this.relay.update(this.config.id, {
        heat: this.heatDemand,
        retryEnabled: this.config.relayRetryEnabled,
        retryDelayMs: this.config.relayRetryDelayMinutes * 60_000,
        minOnMs: this.config.minOnMinutes * 60_000,
        minOffMs: this.config.minOffMinutes * 60_000,
      }, observation);
    } catch (error) {
      relayError = `Failed to control ${this.config.switchTarget.endpointName}: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (temperatures.length) {
      this.persistState();
    }

    const fault = temperatureError ?? relayError;
    if (fault) {
      this.setFault(fault);
    } else {
      this.clearFault();
      this.reportPartialProblems(problems);
    }
  }

  getStatus(): ThermostatStatus {
    return {
      id: this.config.id,
      name: this.config.name,
      mode: this.modeLabel === "OFF" ? "OFF" : "HEAT",
      currentTemperature: this.lastTemperatureAt === undefined ? undefined : this.currentTemperature,
      targetTemperature: this.targetTemperature,
      humidity: this.humidity,
      heating: this.currentHeatingCoolingState === this.hap.Characteristic.CurrentHeatingCoolingState.HEAT,
      demandReason: this.demandReason,
      relayName: this.config.switchTarget.endpointName,
      relayOn: this.relay.isOn,
      relayWaiting: this.relay.waitingReason,
      windowOpen: this.windowOpen,
      fault: this.faultMessage,
      warning: this.lastWarning,
      lastReadingAt: this.lastTemperatureAt,
      lastCycleAt: this.lastCycleAt,
      sources: this.sourceStates,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Faults and persistence
  // ---------------------------------------------------------------------------------------------

  private setFault(message: string): void {
    if (this.faultMessage !== message) {
      this.platform.log.error(`[${this.config.name}] ${message}`);
      this.faultMessage = message;
    }
  }

  private clearFault(): void {
    if (this.faultMessage) {
      this.platform.log.info(`[${this.config.name}] Recovered, Matter devices are answering again.`);
      this.faultMessage = undefined;
    }
  }

  /** Some sources failed but the thermostat can still work: warn once per distinct problem. */
  private reportPartialProblems(problems: string[]): void {
    const summary = problems.join(" | ") || undefined;
    if (summary && summary !== this.lastWarning) {
      this.platform.log.warn(`[${this.config.name}] Some sources did not answer, using the others: ${summary}`);
    }
    this.lastWarning = summary;
  }

  private clampTarget(value: number): number {
    const safe = Number.isFinite(value) ? value : this.config.defaultTargetTemperature;
    return Math.min(Math.max(safe, this.config.minTargetTemperature), this.config.maxTargetTemperature);
  }

  private persistState(): void {
    const next: PersistedState = {
      targetTemperature: this.targetTemperature,
      targetHeatingCoolingState: this.targetHeatingCoolingState,
      temperatureDisplayUnits: this.temperatureDisplayUnits,
      lastTemperature: this.currentTemperature,
    };
    const previous = this.accessory.context.persistedState as PersistedState | undefined;
    if (previous
      && previous.targetTemperature === next.targetTemperature
      && previous.targetHeatingCoolingState === next.targetHeatingCoolingState
      && previous.temperatureDisplayUnits === next.temperatureDisplayUnits
      // Only rewrite the accessory cache for noticeable temperature changes.
      && Math.abs((previous.lastTemperature ?? Number.NaN) - this.currentTemperature) < 0.5) {
      return;
    }

    this.accessory.context.persistedState = next;
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }
}
