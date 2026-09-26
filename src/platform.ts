import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from "homebridge";

import { resolvePlatformConfig } from "./config.js";
import { ControlServer } from "./control-server.js";
import type { ResolvedThermostatConfig, VthermoPlatformConfig } from "./config.js";
import { MatterControllerClient, type MatterUiSnapshot } from "./matter-client.js";
import { referenceKey, type MatterEndpointReference } from "./matter-model.js";
import { withTimeout } from "./node-guard.js";
import { rebindInPlace } from "./rebind.js";
import { RelayController } from "./relay-controller.js";
import { MATTER_STORAGE_DIRECTORY, PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION, STATUS_FILE } from "./settings.js";
import { VthermoAccessory } from "./thermostatAccessory.js";

/** Refresh the settings-page cache once the thermostats had time to do their first reads. */
const UI_SNAPSHOT_DELAY_MS = 90_000;
const CONTROLLER_START_TIMEOUT_MS = 30_000;
const SUBSCRIPTION_RETRY_MS = 5 * 60_000;
/** How often the live status for the settings page is written. */
const STATUS_INTERVAL_MS = 10_000;

export class VthermoPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly controllerClient: MatterControllerClient;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly thermostats: VthermoAccessory[] = [];
  private readonly relays = new Map<string, RelayController>();
  private readonly thermostatConfigs: ResolvedThermostatConfig[] = [];
  private snapshotTimer?: NodeJS.Timeout;
  private statusTimer?: NodeJS.Timeout;
  private controlServer?: ControlServer;
  private readonly subscriptionClosers: Array<() => void> = [];
  private shuttingDown = false;

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

    this.api.on("didFinishLaunching", () => {
      void this.launch();
    });
    this.api.on("shutdown", () => {
      void this.shutdown();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  get historyEnabled(): boolean {
    return (this.config as VthermoPlatformConfig).enableHistory === true;
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

  private async launch(): Promise<void> {
    const resolved = resolvePlatformConfig(this.config as VthermoPlatformConfig);
    this.log.info(`Vthermo ${PLUGIN_VERSION} starting with ${resolved.thermostats.length} thermostat(s).`);
    this.controllerClient.setAddressOverrides(resolved.addressOverrides);
    this.thermostatConfigs.push(...resolved.thermostats);

    if (resolved.thermostats.length) {
      try {
        // Never let a stuck controller start keep the accessories from being published.
        await withTimeout(this.controllerClient.start(), CONTROLLER_START_TIMEOUT_MS, "starting the Matter controller");
        // Devices that were paired again have a new node id; find them from the last scan.
        const cached = await MatterControllerClient.readCachedUiSnapshot(this.api.user.storagePath()).catch(() => undefined);
        if (cached) {
          await this.rebindReferences(cached);
        }
        await this.startControlServer();
      } catch (error) {
        this.log.error(`Could not start the Matter controller: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.syncAccessories(resolved);

    if (!resolved.thermostats.length) {
      return;
    }

    for (const thermostat of this.thermostats) {
      thermostat.start();
    }

    if ((this.config as VthermoPlatformConfig).instantUpdates) {
      void this.startSubscriptions();
    }

    this.statusTimer = setInterval(() => {
      void this.writeStatus();
    }, STATUS_INTERVAL_MS);
    this.statusTimer.unref?.();

    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.controllerClient.buildUiSnapshot()
        .then(async (snapshot) => {
          this.log.debug("Cached Matter UI snapshot for the Vthermo settings page.");
          await this.rebindReferences(snapshot);
        })
        .catch((error) => this.log.debug(`Could not cache Matter UI snapshot: ${error instanceof Error ? error.message : String(error)}`));
    }, UI_SNAPSHOT_DELAY_MS);
    this.snapshotTimer.unref?.();
  }

  /**
   * Points references to devices that were paired again (new node id) at the same device on the
   * new node, matched by unique id / serial number. Works in memory; the settings page does the
   * same and saves it, so the config catches up the next time it is opened.
   */
  private async rebindReferences(snapshot: MatterUiSnapshot): Promise<void> {
    const pairedNodeIds = await this.controllerClient.getPairedNodeIds();
    const options = [
      ...snapshot.temperatureSources,
      ...(snapshot.humiditySources ?? []),
      ...snapshot.switchTargets,
      ...snapshot.contactSensors,
    ];

    for (const thermostat of this.thermostatConfigs) {
      const changed = rebindInPlace([
        ...thermostat.temperatureSources,
        ...thermostat.contactSensors,
        thermostat.switchTarget,
        thermostat.humiditySource,
      ], options, pairedNodeIds);

      if (changed) {
        this.log.warn(`[${thermostat.name}] ${changed} device(s) were paired again under a new Matter node; `
          + "reconnected them automatically. Open the Vthermo settings and save to store this permanently.");
      }
    }
  }

  /** One subscription per node for all window sensors and relays; a change triggers the affected thermostats. */
  private async startSubscriptions(): Promise<void> {
    const byNode = new Map<string, Map<string, MatterEndpointReference>>();
    for (const thermostat of this.thermostats) {
      for (const reference of thermostat.watchedReferences) {
        const references = byNode.get(reference.nodeId) ?? new Map();
        references.set(referenceKey(reference), reference);
        byNode.set(reference.nodeId, references);
      }
    }

    const onChange = (key: string) => {
      for (const thermostat of this.thermostats) {
        if (thermostat.watchedReferences.some((reference) => referenceKey(reference) === key)) {
          thermostat.requestCycle();
        }
      }
    };

    const subscribe = async (nodeId: string, references: MatterEndpointReference[], attempt: number): Promise<void> => {
      if (this.shuttingDown) {
        return;
      }

      try {
        this.subscriptionClosers.push(await this.controllerClient.subscribeToChanges(nodeId, references, onChange));
        this.log.info(`Instant updates enabled for ${references.length} window sensor/relay endpoint(s) on Matter node ${nodeId}.`);
      } catch (error) {
        if (attempt === 1) {
          this.log.warn(`Instant updates for Matter node ${nodeId} are not available yet, using polling meanwhile: `
            + `${error instanceof Error ? error.message : String(error)}`);
        }
        // Keep trying in the background, e.g. until an unreachable hub comes back.
        const retry = setTimeout(() => {
          void subscribe(nodeId, references, attempt + 1);
        }, SUBSCRIPTION_RETRY_MS);
        retry.unref?.();
      }
    };

    for (const [nodeId, references] of byNode) {
      void subscribe(nodeId, [...references.values()], 1);
    }
  }

  /** Lets the settings page pair and scan through this running controller (see control-server.ts). */
  private async startControlServer(): Promise<void> {
    const snapshot = async (discover: boolean) => {
      const result = await this.controllerClient.buildUiSnapshot({ discover });
      await this.rebindReferences(result);
      return { ...result, viaBridge: true };
    };

    const server = new ControlServer(this.api.user.storagePath(), {
      "/snapshot": async (body) => snapshot(body.discover !== false),
      "/pair": async (body) => {
        const pairingCode = typeof body.pairingCode === "string" ? body.pairingCode.trim() : "";
        const deviceIdentifier = typeof body.deviceIdentifier === "string" ? body.deviceIdentifier : "";
        this.log.info(`Pairing a Matter device from the settings page${deviceIdentifier ? ` (${deviceIdentifier})` : ""}.`);
        try {
          await this.controllerClient.commissionDevice(deviceIdentifier, pairingCode);
        } catch (error) {
          if (!(error instanceof Error && error.message.includes("already commissioned into this fabric"))) {
            throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        return snapshot(true);
      },
      "/unpair": async (body) => {
        const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
        this.log.info(`Removing Matter node ${nodeId} from the settings page.`);
        await this.controllerClient.removeNode(nodeId);
        return snapshot(true);
      },
    }, { warn: (message) => this.log.warn(message), debug: (message) => this.log.debug(message) });

    try {
      await server.start();
      this.controlServer = server;
    } catch (error) {
      this.log.warn(`Settings-page pairing while running is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async writeStatus(): Promise<void> {
    const directory = join(this.api.user.storagePath(), MATTER_STORAGE_DIRECTORY);
    const path = join(directory, STATUS_FILE);
    const status = {
      version: PLUGIN_VERSION,
      updatedAt: new Date().toISOString(),
      thermostats: this.thermostats.map((thermostat) => thermostat.getStatus()),
      nodes: this.controllerClient.getNodeStatuses(),
    };

    try {
      await mkdir(directory, { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, "utf8");
      await rename(temporary, path);
    } catch (error) {
      this.log.debug(`Could not write the Vthermo status file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
    }

    for (const thermostat of this.thermostats) {
      thermostat.stop();
    }

    for (const close of this.subscriptionClosers) {
      try {
        close();
      } catch {
        // Already closed.
      }
    }
    await this.controlServer?.stop();
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
