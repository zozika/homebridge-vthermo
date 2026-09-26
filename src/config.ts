import type { PlatformConfig } from "homebridge";

import type { MatterEndpointReference } from "./matter-model.js";

export interface ThermostatConfig {
  id?: string;
  name?: string;
  temperatureSources?: MatterEndpointReference[];
  temperatureSource?: MatterEndpointReference;
  temperatureAggregation?: "average" | "minimum" | "maximum";
  switchTarget?: MatterEndpointReference;
  contactSensors?: MatterEndpointReference[];
  hysteresis?: number;
  checkIntervalSeconds?: number;
  temperatureRefreshIntervalMinutes?: number;
  relayRetryEnabled?: boolean;
  relayRetryDelayMinutes?: number;
  defaultTargetTemperature?: number;
  minTargetTemperature?: number;
  maxTargetTemperature?: number;
  humiditySource?: MatterEndpointReference;
  minOnMinutes?: number;
  minOffMinutes?: number;
  frostProtectionTemperature?: number;
}

export interface NodeAddressOverrideConfig {
  nodeId?: string;
  address?: string;
}

export interface VthermoPlatformConfig extends PlatformConfig {
  name?: string;
  language?: "auto" | "en" | "hu";
  enableVerboseLogging?: boolean;
  /** Experimental: Matter subscriptions for window sensors and relays. */
  instantUpdates?: boolean;
  /** Eve app history graphs for the thermostats. */
  enableHistory?: boolean;
  nodeAddressOverrides?: NodeAddressOverrideConfig[];
  thermostats?: ThermostatConfig[];
  temperatureSources?: MatterEndpointReference[];
  temperatureSource?: MatterEndpointReference;
  temperatureAggregation?: "average" | "minimum" | "maximum";
  switchTarget?: MatterEndpointReference;
  contactSensors?: MatterEndpointReference[];
  hysteresis?: number;
  checkIntervalSeconds?: number;
  temperatureRefreshIntervalMinutes?: number;
  relayRetryEnabled?: boolean;
  relayRetryDelayMinutes?: number;
  defaultTargetTemperature?: number;
  minTargetTemperature?: number;
  maxTargetTemperature?: number;
}

export interface ResolvedThermostatConfig {
  id: string;
  name: string;
  temperatureSources: MatterEndpointReference[];
  temperatureAggregation: "average" | "minimum" | "maximum";
  switchTarget: MatterEndpointReference;
  contactSensors: MatterEndpointReference[];
  hysteresis: number;
  checkIntervalSeconds: number;
  relayRetryEnabled: boolean;
  relayRetryDelayMinutes: number;
  defaultTargetTemperature: number;
  minTargetTemperature: number;
  maxTargetTemperature: number;
  humiditySource?: MatterEndpointReference;
  minOnMinutes: number;
  minOffMinutes: number;
  /** 0 = disabled. */
  frostProtectionTemperature: number;
}

export interface InvalidThermostatConfig {
  id: string;
  name: string;
  errors: string[];
}

export interface ResolvePlatformResult {
  thermostats: ResolvedThermostatConfig[];
  invalidThermostats: InvalidThermostatConfig[];
  addressOverrides: Array<{ nodeId: string; address: string }>;
}

const DEFAULT_HYSTERESIS = 0.5;
const DEFAULT_CHECK_INTERVAL_SECONDS = 30;
const DEFAULT_RELAY_RETRY_ENABLED = false;
const DEFAULT_RELAY_RETRY_DELAY_MINUTES = 5;
const DEFAULT_TARGET_TEMPERATURE = 21;
const DEFAULT_MIN_TARGET_TEMPERATURE = 10;
const DEFAULT_MAX_TARGET_TEMPERATURE = 30;

const MIN_HYSTERESIS = 0.1;
const MAX_HYSTERESIS = 5;
const MIN_CHECK_INTERVAL_SECONDS = 5;
const MAX_CHECK_INTERVAL_SECONDS = 3600;
const MIN_ALLOWED_TARGET_TEMPERATURE = 5;
const MAX_ALLOWED_TARGET_TEMPERATURE = 35;
const MIN_TARGET_RANGE = 1;
const MAX_MIN_RUN_MINUTES = 60;
const MIN_FROST_TEMPERATURE = 3;
const MAX_FROST_TEMPERATURE = 15;
const MAX_SENSOR_OFFSET = 10;
const TEMPERATURE_AGGREGATIONS = new Set(["average", "minimum", "maximum"]);

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isLegacyHomebridgeReference(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }

  return typeof value.uniqueId === "string"
    && typeof value.characteristicType === "string"
    && typeof value.serviceName === "string"
    && typeof value.controllerId !== "string";
}

function isLegacyNativeHomeKitReference(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }

  return typeof value.controllerId === "string"
    && typeof value.deviceId === "string"
    && typeof value.accessoryId === "number";
}

function isReference(value: unknown): value is MatterEndpointReference {
  if (!isObject(value)) {
    return false;
  }

  return typeof value.nodeId === "string"
    && typeof value.deviceIdentifier === "string"
    && typeof value.endpointId === "number"
    && typeof value.clusterType === "string"
    && typeof value.endpointName === "string"
    && typeof value.deviceName === "string"
    && typeof value.nodeName === "string";
}

/** Copies a reference and keeps only a sane calibration offset. */
function sanitizeReference(reference: MatterEndpointReference): MatterEndpointReference {
  const { offset, ...rest } = reference;
  const numeric = asNumber(offset);
  return numeric === undefined || numeric === 0
    ? rest
    : { ...rest, offset: clamp(Math.round(numeric * 10) / 10, -MAX_SENSOR_OFFSET, MAX_SENSOR_OFFSET) };
}

function getReferenceArray(value: unknown): MatterEndpointReference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isReference).map(sanitizeReference);
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "thermostat";
}

function normalizeThermostatId(value: unknown, fallbackName: string, index: number): string {
  if (typeof value === "string" && value.trim().length) {
    return slugify(value.trim());
  }

  return `${slugify(fallbackName)}-${index + 1}`;
}

function extractThermostatConfigs(config: VthermoPlatformConfig): ThermostatConfig[] {
  if (Array.isArray(config.thermostats)) {
    return config.thermostats.filter(isObject) as ThermostatConfig[];
  }

  const hasLegacyFields = [
    config.temperatureSource,
    config.temperatureSources,
    config.switchTarget,
    config.contactSensors,
    config.hysteresis,
    config.checkIntervalSeconds,
    config.temperatureRefreshIntervalMinutes,
    config.relayRetryEnabled,
    config.relayRetryDelayMinutes,
    config.defaultTargetTemperature,
    config.minTargetTemperature,
    config.maxTargetTemperature,
  ].some((value) => value !== undefined);

  if (!hasLegacyFields) {
    return [];
  }

  return [{
    id: "legacy-thermostat",
    name: typeof config.name === "string" && config.name.trim().length
      ? config.name.trim()
      : "Virtual Thermostat",
    temperatureSource: config.temperatureSource,
    temperatureSources: config.temperatureSources,
    temperatureAggregation: config.temperatureAggregation,
    switchTarget: config.switchTarget,
    contactSensors: config.contactSensors,
    hysteresis: config.hysteresis,
    checkIntervalSeconds: config.checkIntervalSeconds,
    temperatureRefreshIntervalMinutes: config.temperatureRefreshIntervalMinutes,
    relayRetryEnabled: config.relayRetryEnabled,
    relayRetryDelayMinutes: config.relayRetryDelayMinutes,
    defaultTargetTemperature: config.defaultTargetTemperature,
    minTargetTemperature: config.minTargetTemperature,
    maxTargetTemperature: config.maxTargetTemperature,
  }];
}

function collectLegacyReferenceErrors(thermostat: ThermostatConfig, errors: string[]): void {
  if (Array.isArray(thermostat.temperatureSources) && thermostat.temperatureSources.some(isLegacyHomebridgeReference)) {
    errors.push("Legacy Homebridge temperature references are no longer supported. Re-select the source from a paired Matter node.");
  }

  if (isLegacyHomebridgeReference(thermostat.temperatureSource)) {
    errors.push("Legacy Homebridge temperature source is no longer supported. Re-select the source from a paired Matter node.");
  }

  if (isLegacyHomebridgeReference(thermostat.switchTarget)) {
    errors.push("Legacy Homebridge switch target is no longer supported. Re-select the target from a paired Matter node.");
  }

  if (Array.isArray(thermostat.contactSensors) && thermostat.contactSensors.some(isLegacyHomebridgeReference)) {
    errors.push("Legacy Homebridge door/window sensor references are no longer supported. Re-select them from a paired Matter node.");
  }

  if (Array.isArray(thermostat.temperatureSources) && thermostat.temperatureSources.some(isLegacyNativeHomeKitReference)) {
    errors.push("Native HomeKit controller references are no longer supported in Matter mode. Re-select the source from a paired Matter node.");
  }

  if (isLegacyNativeHomeKitReference(thermostat.temperatureSource)) {
    errors.push("Native HomeKit temperature source is no longer supported in Matter mode. Re-select the source from a paired Matter node.");
  }

  if (isLegacyNativeHomeKitReference(thermostat.switchTarget)) {
    errors.push("Native HomeKit switch target is no longer supported in Matter mode. Re-select the target from a paired Matter node.");
  }

  if (Array.isArray(thermostat.contactSensors) && thermostat.contactSensors.some(isLegacyNativeHomeKitReference)) {
    errors.push("Native HomeKit contact sensor references are no longer supported in Matter mode. Re-select them from a paired Matter node.");
  }
}

function resolveSingleThermostat(
  thermostat: ThermostatConfig,
  index: number,
): { config?: ResolvedThermostatConfig; invalid?: InvalidThermostatConfig } {
  const errors: string[] = [];
  collectLegacyReferenceErrors(thermostat, errors);

  const name = typeof thermostat.name === "string" && thermostat.name.trim().length
    ? thermostat.name.trim()
    : `Virtual Thermostat ${index + 1}`;
  const id = normalizeThermostatId(thermostat.id, name, index);

  const temperatureSources = getReferenceArray(thermostat.temperatureSources);
  const legacyTemperatureSource = isReference(thermostat.temperatureSource) ? sanitizeReference(thermostat.temperatureSource) : undefined;
  const normalizedTemperatureSources = temperatureSources.length
    ? temperatureSources
    : legacyTemperatureSource
      ? [legacyTemperatureSource]
      : [];
  const contactSensors = getReferenceArray(thermostat.contactSensors);

  const minTargetTemperature = clamp(
    asNumber(thermostat.minTargetTemperature) ?? DEFAULT_MIN_TARGET_TEMPERATURE,
    MIN_ALLOWED_TARGET_TEMPERATURE,
    MAX_ALLOWED_TARGET_TEMPERATURE,
  );

  const maxTargetTemperature = clamp(
    asNumber(thermostat.maxTargetTemperature) ?? DEFAULT_MAX_TARGET_TEMPERATURE,
    MIN_ALLOWED_TARGET_TEMPERATURE,
    MAX_ALLOWED_TARGET_TEMPERATURE,
  );

  let normalizedMin = Math.min(minTargetTemperature, maxTargetTemperature);
  let normalizedMax = Math.max(minTargetTemperature, maxTargetTemperature);

  // HomeKit rejects a TargetTemperature range where min >= max.
  if (normalizedMax - normalizedMin < MIN_TARGET_RANGE) {
    normalizedMax = Math.min(normalizedMin + MIN_TARGET_RANGE, MAX_ALLOWED_TARGET_TEMPERATURE);
    normalizedMin = normalizedMax - MIN_TARGET_RANGE;
  }

  const defaultTargetTemperature = clamp(
    asNumber(thermostat.defaultTargetTemperature) ?? DEFAULT_TARGET_TEMPERATURE,
    normalizedMin,
    normalizedMax,
  );

  const hysteresis = clamp(
    asNumber(thermostat.hysteresis) ?? DEFAULT_HYSTERESIS,
    MIN_HYSTERESIS,
    MAX_HYSTERESIS,
  );

  const checkIntervalSeconds = clamp(
    Math.round(asNumber(thermostat.checkIntervalSeconds) ?? DEFAULT_CHECK_INTERVAL_SECONDS),
    MIN_CHECK_INTERVAL_SECONDS,
    MAX_CHECK_INTERVAL_SECONDS,
  );

  const relayRetryEnabled = typeof thermostat.relayRetryEnabled === "boolean"
    ? thermostat.relayRetryEnabled
    : DEFAULT_RELAY_RETRY_ENABLED;

  const relayRetryDelayMinutes = clamp(
    Math.round(asNumber(thermostat.relayRetryDelayMinutes) ?? DEFAULT_RELAY_RETRY_DELAY_MINUTES),
    1,
    180,
  );

  const minOnMinutes = clamp(Math.round(asNumber(thermostat.minOnMinutes) ?? 0), 0, MAX_MIN_RUN_MINUTES);
  const minOffMinutes = clamp(Math.round(asNumber(thermostat.minOffMinutes) ?? 0), 0, MAX_MIN_RUN_MINUTES);
  const rawFrost = asNumber(thermostat.frostProtectionTemperature) ?? 0;
  const frostProtectionTemperature = rawFrost <= 0 ? 0 : clamp(rawFrost, MIN_FROST_TEMPERATURE, MAX_FROST_TEMPERATURE);
  const humiditySource = isReference(thermostat.humiditySource) ? sanitizeReference(thermostat.humiditySource) : undefined;

  const temperatureAggregation = TEMPERATURE_AGGREGATIONS.has(thermostat.temperatureAggregation ?? "")
    ? thermostat.temperatureAggregation as "average" | "minimum" | "maximum"
    : "average";

  if (!normalizedTemperatureSources.length) {
    errors.push("Missing temperature sources. Pick at least one Matter temperature endpoint.");
  }

  if (!isReference(thermostat.switchTarget)) {
    errors.push("Missing switch target. Pick a writable Matter On/Off endpoint.");
  }

  if (normalizedTemperatureSources.some((source) => source.clusterType !== "temperatureMeasurement")) {
    errors.push("Every temperature source must use a Matter Temperature Measurement endpoint.");
  }

  if (isReference(thermostat.switchTarget) && thermostat.switchTarget.clusterType !== "onOff") {
    errors.push("Switch target must use a Matter On/Off endpoint.");
  }

  if (contactSensors.some((sensor) => sensor.clusterType !== "booleanState")) {
    errors.push("Every door/window sensor must use a Matter Contact Sensor endpoint.");
  }

  if (humiditySource && humiditySource.clusterType !== "relativeHumidityMeasurement") {
    errors.push("The humidity source must use a Matter Relative Humidity Measurement endpoint.");
  }

  if (errors.length || !normalizedTemperatureSources.length || !isReference(thermostat.switchTarget)) {
    return {
      invalid: {
        id,
        name,
        errors,
      },
    };
  }

  return {
    config: {
      id,
      name,
      temperatureSources: normalizedTemperatureSources,
      temperatureAggregation,
      switchTarget: sanitizeReference(thermostat.switchTarget),
      contactSensors,
      hysteresis,
      checkIntervalSeconds,
      relayRetryEnabled,
      relayRetryDelayMinutes,
      defaultTargetTemperature,
      minTargetTemperature: normalizedMin,
      maxTargetTemperature: normalizedMax,
      humiditySource,
      minOnMinutes,
      minOffMinutes,
      frostProtectionTemperature,
    },
  };
}

export function resolvePlatformConfig(config: VthermoPlatformConfig): ResolvePlatformResult {
  const thermostats = extractThermostatConfigs(config);
  const resolvedThermostats: ResolvedThermostatConfig[] = [];
  const invalidThermostats: InvalidThermostatConfig[] = [];
  const seenIds = new Set<string>();

  for (const [index, thermostat] of thermostats.entries()) {
    const resolved = resolveSingleThermostat(thermostat, index);
    const target = resolved.config ?? resolved.invalid;

    if (!target) {
      continue;
    }

    if (seenIds.has(target.id)) {
      invalidThermostats.push({
        id: target.id,
        name: target.name,
        errors: ["Thermostat ids must be unique. Rename or recreate one of the duplicates."],
      });
      continue;
    }

    seenIds.add(target.id);

    if (resolved.config) {
      resolvedThermostats.push(resolved.config);
      continue;
    }

    invalidThermostats.push(resolved.invalid!);
  }

  return {
    thermostats: resolvedThermostats,
    invalidThermostats,
    addressOverrides: resolveAddressOverrides(config),
  };
}

function resolveAddressOverrides(config: VthermoPlatformConfig): Array<{ nodeId: string; address: string }> {
  if (!Array.isArray(config.nodeAddressOverrides)) {
    return [];
  }

  const overrides = new Map<string, string>();
  for (const entry of config.nodeAddressOverrides) {
    if (!isObject(entry) || typeof entry.nodeId !== "string" || typeof entry.address !== "string") {
      continue;
    }

    const nodeId = entry.nodeId.trim();
    const address = entry.address.trim();
    if (nodeId && address) {
      overrides.set(nodeId, address);
    }
  }

  return [...overrides.entries()].map(([nodeId, address]) => ({ nodeId, address }));
}
