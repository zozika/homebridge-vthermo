import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from "homebridge";

import { resolvePlatformConfig } from "./config.js";
import type { ResolvedThermostatConfig, VthermoPlatformConfig } from "./config.js";
import { MatterControllerClient } from "./matter-client.js";
import { referenceKey } from "./matter-model.js";
import { RelayController } from "./relay-controller.js";
import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from "./settings.js";
import { VthermoAccessory } from "./thermostatAccessory.js";

/** Refresh the settings-page cache once the thermostats had time to do their first reads. */
const UI_SNAPSHOT_DELAY_MS = 90_000;

export class VthermoPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly controllerClient: MatterControllerClient;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly thermostats: VthermoAccessory[] = [];
  private readonly relays = new Map<string, RelayController>();
  private snapshotTimer?: NodeJS.Timeout;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.controllerClient = new MatterControllerClient({
      log,
      storagePath: api.user.storagePath(),
      verbose: () => this.verboseLoggingEnabled,
    });

    this.api.on("didFinishLaunching", () => this.launch());
    this.api.on("shutdown", () => {
      void this.shutdown();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  get verboseLoggingEnabled(): boolean {
    return Boolean((this.config as VthermoPlatformConfig).enableVerboseLogging);
  }

  debug(message: string): void {
    if (this.verboseLoggingEnabled) {
      this.log.info(message);
    } else {
      this.log.debug(message);
    }
  }

  private launch(): void {
    const resolved = resolvePlatformConfig(this.config as VthermoPlatformConfig);
    this.log.info(`Vthermo ${PLUGIN_VERSION} starting with ${resolved.thermostats.length} thermostat(s).`);
    this.controllerClient.setAddressOverrides(resolved.addressOverrides);

    this.syncAccessories(resolved);

    if (!resolved.thermostats.length) {
      return;
    }

    this.controllerClient.start().catch((error) => {
      this.log.error(`Could not start the Matter controller: ${error instanceof Error ? error.message : String(error)}`);
    });

    for (const thermostat of this.thermostats) {
      thermostat.start();
    }

    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.controllerClient.buildUiSnapshot()
        .then(() => this.log.debug("Cached Matter UI snapshot for the Vthermo settings page."))
        .catch((error) => this.log.debug(`Could not cache Matter UI snapshot: ${error instanceof Error ? error.message : String(error)}`));
    }, UI_SNAPSHOT_DELAY_MS);
    this.snapshotTimer.unref?.();
  }

  private async shutdown(): Promise<void> {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
    }

    for (const thermostat of this.thermostats) {
      thermostat.stop();
    }

    await this.controllerClient.close();
  }

  private syncAccessories(resolved: ReturnType<typeof resolvePlatformConfig>): void {
    const configured = new Set<string>();

    if (!resolved.thermostats.length && !resolved.invalidThermostats.length) {
      this.log.info("Vthermo has no thermostats configured yet. Open the plugin settings to add one.");
    }

    for (const invalid of resolved.invalidThermostats) {
      this.log.warn(`[${invalid.name}] is not fully configured yet: ${invalid.errors.join(" ")}`);
      // Keep the cached accessory so HomeKit rooms, scenes and automations survive a temporary config problem.
      const uuid = this.thermostatUuid(invalid.id);
      const cached = this.cachedAccessories.get(uuid);
      if (cached) {
        configured.add(uuid);
        cached.getService(this.Service.Thermostat)?.updateCharacteristic(
          this.api.hap.Characteristic.StatusFault,
          this.api.hap.Characteristic.StatusFault.GENERAL_FAULT,
        );
      }
    }

    for (const thermostat of resolved.thermostats) {
      const uuid = this.thermostatUuid(thermostat.id);
      configured.add(uuid);

      let accessory = this.cachedAccessories.get(uuid);
      const isNew = !accessory;
      if (!accessory) {
        accessory = new this.api.platformAccessory(thermostat.name, uuid);
        this.cachedAccessories.set(uuid, accessory);
      } else if (accessory.displayName !== thermostat.name) {
        accessory.displayName = thermostat.name;
      }

      accessory.context.config = thermostat;
      this.thermostats.push(new VthermoAccessory(this, accessory, thermostat, this.relayFor(thermostat)));

      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    for (const relay of this.relays.values()) {
      if (relay.thermostatCount > 1) {
        this.log.info(`${relay.label} is shared by ${relay.thermostatCount} thermostats; it stays on while any of them needs heat.`);
      }
    }

    for (const [uuid, accessory] of this.cachedAccessories) {
      if (configured.has(uuid)) {
        continue;
      }

      this.log.info(`Removing cached accessory ${accessory.displayName} because it is no longer configured.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.delete(uuid);
    }
  }

  private relayFor(thermostat: ResolvedThermostatConfig): RelayController {
    const key = referenceKey(thermostat.switchTarget);
    let relay = this.relays.get(key);
    if (!relay) {
      relay = new RelayController(thermostat.switchTarget, this.controllerClient, {
        info: (message) => this.log.info(message),
        warn: (message) => this.log.warn(message),
        debug: (message) => this.debug(message),
      });
      this.relays.set(key, relay);
    }

    return relay;
  }

  private thermostatUuid(id: string): string {
    return this.api.hap.uuid.generate(`${PLUGIN_NAME}:${id}`);
  }
}
