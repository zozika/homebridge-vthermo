import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";

import "@matter/nodejs";

import {
  ControllerBehavior,
  LogDestination,
  LogFormat,
  Logger,
  LogLevel,
  Seconds,
  ServerAddress,
  ServerNode,
  VendorId,
  type ClientNode,
  type ServerAddressUdp,
} from "@matter/main";
import { PeerAddress, PeerSet, SessionParameters } from "@matter/protocol";
import { BasicInformationClient } from "@matter/main/behaviors/basic-information";
import { BooleanStateClient } from "@matter/main/behaviors/boolean-state";
import { OnOffClient } from "@matter/main/behaviors/on-off";
import { RelativeHumidityMeasurementClient } from "@matter/main/behaviors/relative-humidity-measurement";
import { TemperatureMeasurementClient } from "@matter/main/behaviors/temperature-measurement";
import { NodeJsEnvironment } from "@matter/nodejs";
import { ManualPairingCodeCodec, QrPairingCodeCodec } from "@matter/types/schema";

import {
  createOptionLabel,
  describeReference,
  formatAddress,
  getEndpointDeviceType,
  getEndpointDeviceTypes,
  getEndpointIdentity,
  getEndpointName,
  getNodeName,
  referenceKey,
  summarizeDiscoveredNode,
  type MatterClusterType,
  type MatterCommissionableNode,
  type MatterEndpointReference,
  type MatterNodeInventory,
  type MatterNodeProblem,
  type MatterOptionPurpose,
  type MatterOption,
  type MatterPairedNodeSummary,
} from "./matter-model.js";
import { installMatterCompatibilityPatches } from "./matter-compat.js";
import { NodeGuard } from "./node-guard.js";
import { MATTER_CONTROLLER_NODE_ID, MATTER_STORAGE_DIRECTORY, PLUGIN_VERSION } from "./settings.js";

const DESCRIPTOR_CLUSTER_ID = 0x001d;
const PARTS_LIST_ATTRIBUTE_ID = 0x0003;

const CLUSTER_ATTRIBUTES: Record<MatterClusterType, { clusterId: number; attributeId: number }> = {
  temperatureMeasurement: { clusterId: 0x0402, attributeId: 0x0000 },
  relativeHumidityMeasurement: { clusterId: 0x0405, attributeId: 0x0000 },
  booleanState: { clusterId: 0x0045, attributeId: 0x0000 },
  onOff: { clusterId: 0x0006, attributeId: 0x0000 },
};

const CLUSTER_BEHAVIORS: Record<MatterClusterType, unknown> = {
  temperatureMeasurement: TemperatureMeasurementClient,
  relativeHumidityMeasurement: RelativeHumidityMeasurementClient,
  onOff: OnOffClient,
  booleanState: BooleanStateClient,
};

const INVENTORY_KINDS: Array<{ clusterType: MatterClusterType; purpose: MatterOptionPurpose; list: keyof InventoryLists }> = [
  { clusterType: "temperatureMeasurement", purpose: "temperature", list: "temperatureSources" },
  { clusterType: "relativeHumidityMeasurement", purpose: "humidity", list: "humiditySources" },
  { clusterType: "onOff", purpose: "switch", list: "switchTargets" },
  { clusterType: "booleanState", purpose: "contact", list: "contactSensors" },
];

type InventoryLists = Pick<MatterNodeInventory, "temperatureSources" | "humiditySources" | "switchTargets" | "contactSensors">;

/** How long a "device rejected our pairing" diagnosis stays valid. */
const PROBLEM_TTL_MS = 10 * 60_000;

const SOFTWARE_VERSION = 200;
const MDNS_SCANNER_SETTLE_MS = 500;
const MDNS_SCANNER_RETRY_ATTEMPTS = 8;
const UI_SNAPSHOT_CACHE_FILE = "ui-snapshot.json";

/** Runtime reads and commands. Deliberately shorter than matter.js' own ~55s give-up. */
const OPERATION_TIMEOUT_MS = 20_000;
/** Node startup, structure scans and inventory reads of large bridges. */
const INVENTORY_TIMEOUT_MS = 90_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 120_000;

export type WarningCode = "matterOnly" | "bridgeHint" | "storageShared" | "cachedSnapshot" | "controllerBusy";

export interface MatterLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface MatterClientOptions {
  log: MatterLogger;
  storagePath: string;
  verbose?: () => boolean;
}

export interface NodeAddressOverride {
  nodeId: string;
  address: string;
}

export type EndpointReadResult =
  | { ok: true; value: number | boolean }
  | { ok: false; error: string };

export interface MatterNodeStatus {
  nodeId: string;
  name: string;
  online: boolean;
  lastError?: string;
  lastSuccessAt?: number;
  problem?: MatterNodeProblem;
}

export interface MatterUiSnapshot {
  discoveredNodes: MatterCommissionableNode[];
  pairedNodes: MatterPairedNodeSummary[];
  temperatureSources: MatterOption[];
  humiditySources: MatterOption[];
  switchTargets: MatterOption[];
  contactSensors: MatterOption[];
  warnings: string[];
  cachedAt?: string;
}

interface PairingCodeDetails {
  passcode: number;
  longDiscriminator?: number;
  shortDiscriminator?: number;
}

type ReadReport = {
  kind?: string;
  path?: {
    endpointId?: number;
    clusterId?: number;
    attributeId?: number;
  };
  value?: unknown;
  status?: number;
};

type OnOffCommands = {
  on?: () => Promise<void>;
  off?: () => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Accepts "1.2.3.4", "1.2.3.4:5540", "fd00::1", "[fd00::1]:5540". */
export function parseAddressOverride(value: string): ServerAddressUdp | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  let ip = trimmed;
  let port = 5540;

  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed) {
    ip = bracketed[1]!;
    port = bracketed[2] ? Number(bracketed[2]) : port;
  } else if (/^[^:]+:\d+$/.test(trimmed)) {
    const [host, rawPort] = trimmed.split(":");
    ip = host!;
    port = Number(rawPort);
  }

  if (!(isIPv4(ip) || isIPv6(ip.split("%", 1)[0] ?? "")) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }

  return { type: "udp", ip, port };
}

export class MatterControllerClient {
  private readonly log: MatterLogger;
  private readonly storagePath: string;
  private readonly isVerbose: () => boolean;
  private readonly guard: NodeGuard;
  private readonly addressOverrides = new Map<string, ServerAddressUdp>();
  private controllerPromise?: Promise<ServerNode>;
  private controllerOnlinePromise?: Promise<ServerNode>;
  private closed = false;
  /** nodeId -> "@fabric:node" as matter.js prints it, and the reverse. */
  private readonly peerKeys = new Map<string, string>();
  private readonly nodeNames = new Map<string, string>();
  private readonly peerProblems = new Map<string, { problem: MatterNodeProblem; at: number }>();
  private readonly diagnosticsDestination = `vthermo-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(options: MatterClientOptions) {
    this.log = options.log;
    this.storagePath = options.storagePath;
    this.isVerbose = options.verbose ?? (() => false);
    this.guard = new NodeGuard({
      timeoutMs: OPERATION_TIMEOUT_MS,
      baseBackoffMs: BASE_BACKOFF_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
      onStateChange: (nodeId, online, detail) => {
        if (online) {
          this.log.info(`Matter node ${nodeId} is reachable again.`);
        } else {
          this.log.warn(`Matter node ${nodeId} is not reachable: ${detail ?? "unknown error"}. Retrying in the background.`);
        }
      },
    });
    installMatterCompatibilityPatches(this.log);
    this.applyMatterLogLevel();
    this.installDiagnostics();
  }

  /**
   * matter.js swallows the reason a reconnect failed and only reports "not reachable". Listen to
   * its PeerSet debug log so we can tell users when a device rejected us because it no longer
   * has our pairing (NoSharedTrustRoots) - that needs re-pairing, not network debugging.
   */
  private installDiagnostics(): void {
    try {
      Logger.destinations[this.diagnosticsDestination] = LogDestination({
        name: this.diagnosticsDestination,
        level: LogLevel.FATAL,
        facilityLevels: { PeerSet: LogLevel.DEBUG },
        format: LogFormat.formats.plain,
        write: (text: string) => this.inspectMatterLog(text),
      });
    } catch (error) {
      this.log.debug(`Could not install Matter diagnostics: ${errorMessage(error)}`);
    }
  }

  private inspectMatterLog(text: string): void {
    if (!text.includes("NoSharedTrustRoots")) {
      return;
    }

    const peer = /@[0-9a-f]+:[0-9a-f]+/i.exec(text)?.[0];
    if (peer) {
      this.peerProblems.set(peer, { problem: "notPaired", at: Date.now() });
    }
  }

  private problemFor(nodeId: string): MatterNodeProblem | undefined {
    const peer = this.peerKeys.get(nodeId);
    const entry = peer ? this.peerProblems.get(peer) : undefined;
    return entry && Date.now() - entry.at < PROBLEM_TTL_MS ? entry.problem : undefined;
  }

  /** Turns a generic "not reachable" into an actionable message when we know better. */
  private describeNodeError(nodeId: string, error: unknown): string {
    if (this.problemFor(nodeId) === "notPaired") {
      const name = this.nodeNames.get(nodeId) ?? nodeId;
      return `${name} no longer accepts this controller (NoSharedTrustRoots): its Matter pairing was removed on the device. `
        + "Remove it in the Vthermo settings and pair it again.";
    }

    return errorMessage(error);
  }

  private rememberNode(node: ClientNode): void {
    this.nodeNames.set(node.id, getNodeName(node));
    const peerAddress = node.state.commissioning.peerAddress;
    if (peerAddress) {
      this.peerKeys.set(node.id, String(PeerAddress(peerAddress)));
    }
  }

  /** Health of every node the thermostats talked to, for the status page. */
  getNodeStatuses(): MatterNodeStatus[] {
    return [...this.nodeNames.entries()].map(([nodeId, name]) => {
      const health = this.guard.getHealth(nodeId);
      return {
        nodeId,
        name,
        online: health.consecutiveFailures === 0 && health.lastSuccessAt !== undefined,
        lastError: health.lastError ? this.describeNodeError(nodeId, health.lastError) : undefined,
        lastSuccessAt: health.lastSuccessAt,
        problem: this.problemFor(nodeId),
      };
    });
  }

  /** Ids of all nodes currently paired with this controller. */
  async getPairedNodeIds(): Promise<Set<string>> {
    const controller = await this.getOnlineController();
    return new Set(this.getCommissionedNodes(controller).map((node) => node.id));
  }

  /**
   * matter.js logs at DEBUG by default, including every packet payload. Keep it quiet unless
   * detailed logging is on; MATTER_LOG_LEVEL in the environment still wins for deep debugging.
   */
  private applyMatterLogLevel(): void {
    if (process.env.MATTER_LOG_LEVEL) {
      return;
    }

    try {
      Logger.level = this.isVerbose() ? LogLevel.INFO : LogLevel.WARN;
    } catch (error) {
      this.log.debug(`Could not set the matter.js log level: ${errorMessage(error)}`);
    }
  }

  static async readCachedUiSnapshot(storagePath: string): Promise<MatterUiSnapshot | undefined> {
    const cachePath = MatterControllerClient.getUiSnapshotCachePath(storagePath);
    const [content, metadata] = await Promise.all([
      readFile(cachePath, "utf8"),
      stat(cachePath),
    ]);
    const parsed = JSON.parse(content) as unknown;

    if (!MatterControllerClient.isUiSnapshot(parsed)) {
      return undefined;
    }

    return {
      ...parsed,
      humiditySources: Array.isArray(parsed.humiditySources) ? parsed.humiditySources : [],
      cachedAt: parsed.cachedAt ?? metadata.mtime.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    await this.getOnlineController();
  }

  setAddressOverrides(overrides: NodeAddressOverride[]): void {
    this.addressOverrides.clear();
    for (const override of overrides) {
      const address = parseAddressOverride(override.address);
      if (!address) {
        this.log.warn(`Ignoring invalid fixed address "${override.address}" for Matter node ${override.nodeId}.`);
        continue;
      }

      this.addressOverrides.set(override.nodeId, address);
      this.log.info(`Matter node ${override.nodeId} will use the fixed address ${ServerAddress.urlFor(address)}.`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      delete Logger.destinations[this.diagnosticsDestination];
    } catch {
      // Already gone.
    }
    const controllerPromise = this.controllerPromise;
    this.controllerPromise = undefined;
    this.controllerOnlinePromise = undefined;

    if (!controllerPromise) {
      return;
    }

    try {
      const controller = await controllerPromise;
      await controller.close();
    } catch (error) {
      this.debug(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Runtime API used by the thermostats
  // ---------------------------------------------------------------------------------------------

  /**
   * Reads every referenced endpoint. References that live on the same node are fetched with one
   * batched Matter read. Each reference gets its own result so one bad sensor does not hide the
   * others. Temperatures come back in °C, contact sensors as `true` = open, switches as on/off.
   */
  async readEndpoints(references: MatterEndpointReference[]): Promise<Map<string, EndpointReadResult>> {
    const results = new Map<string, EndpointReadResult>();
    const byNode = new Map<string, MatterEndpointReference[]>();

    for (const reference of references) {
      const list = byNode.get(reference.nodeId) ?? [];
      if (!list.some((entry) => referenceKey(entry) === referenceKey(reference))) {
        list.push(reference);
      }
      byNode.set(reference.nodeId, list);
    }

    await Promise.all([...byNode.entries()].map(async ([nodeId, nodeReferences]) => {
      try {
        const values = await this.guard.run(
          nodeId,
          `reading ${nodeReferences.length} attribute(s) from node ${nodeId}`,
          () => this.withMdnsScannerRetry(`reading node ${nodeId}`, () => this.readNodeReferences(nodeId, nodeReferences)),
        );

        for (const [key, result] of values) {
          results.set(key, result);
        }
      } catch (error) {
        const message = this.describeNodeError(nodeId, error);
        for (const reference of nodeReferences) {
          results.set(referenceKey(reference), { ok: false, error: message });
        }
      }
    }));

    return results;
  }

  async setSwitchState(reference: MatterEndpointReference, enabled: boolean): Promise<void> {
    await this.switchWithGuard(reference, enabled).catch((error) => {
      if (this.problemFor(reference.nodeId)) {
        throw new Error(this.describeNodeError(reference.nodeId, error));
      }
      throw error;
    });
  }

  private async switchWithGuard(reference: MatterEndpointReference, enabled: boolean): Promise<void> {
    await this.guard.run(
      reference.nodeId,
      `switching ${describeReference(reference)} ${enabled ? "on" : "off"}`,
      () => this.withMdnsScannerRetry(`controlling ${describeReference(reference)}`, async () => {
        const node = await this.getStartedNode(reference.nodeId);
        const endpoint = node.endpoints.for(reference.endpointId);
        if (!endpoint.behaviors.has(OnOffClient)) {
          throw new Error(`Endpoint ${reference.endpointId} no longer exposes ${reference.clusterType}.`);
        }

        const commands = endpoint.commandsOf(OnOffClient) as unknown as OnOffCommands;
        const command = enabled ? commands.on : commands.off;
        if (typeof command !== "function") {
          throw new Error(`Switch target ${describeReference(reference)} does not accept an ${enabled ? "On" : "Off"} command.`);
        }

        await command();
      }),
    );
  }

  /**
   * Experimental: asks the node to report changes of these endpoints (window sensors, relay) so the
   * thermostat can react within a second instead of at the next poll. matter.js keeps the
   * subscription alive and re-establishes it after reconnects. Polling continues regardless, so a
   * failing subscription only costs speed. Returns a function that cancels the subscription.
   */
  async subscribeToChanges(
    nodeId: string,
    references: MatterEndpointReference[],
    onChange: (key: string) => void,
  ): Promise<() => void> {
    const byPath = new Map(references.map((reference) => {
      const { clusterId, attributeId } = CLUSTER_ATTRIBUTES[reference.clusterType];
      return [`${reference.endpointId}/${clusterId}/${attributeId}`, referenceKey(reference)];
    }));

    const node = await this.guard.run(nodeId, `preparing the subscription for node ${nodeId}`, () => this.getStartedNode(nodeId));
    const request = {
      keepSubscriptions: true,
      isFabricFiltered: true,
      interactionModelRevision: SessionParameters.defaults.interactionModelRevision,
      attributeRequests: [...byPath.keys()].map((path) => {
        const [endpointId, clusterId, attributeId] = path.split("/").map(Number);
        return { endpointId, clusterId, attributeId };
      }),
      minIntervalFloor: Seconds(1),
      maxIntervalCeiling: Seconds(60),
      sustain: true,
      updated: async (data: AsyncIterable<Iterable<ReadReport>>) => {
        for await (const chunk of data) {
          for (const report of chunk) {
            const key = byPath.get(`${Number(report.path?.endpointId)}/${Number(report.path?.clusterId)}/${Number(report.path?.attributeId)}`);
            if (key && report.kind === "attr-value") {
              onChange(key);
            }
          }
        }
      },
    };

    const subscription = await node.interaction.subscribe(request as never) as unknown as { close(): void };
    return () => subscription.close();
  }

  isNodeBlocked(nodeId: string): boolean {
    return this.guard.isBlocked(nodeId);
  }

  // ---------------------------------------------------------------------------------------------
  // Pairing / UI API
  // ---------------------------------------------------------------------------------------------

  async discoverCommissionableNodes(): Promise<MatterCommissionableNode[]> {
    const controller = await this.getOnlineController();
    const pairedDeviceIds = new Set(this.getCommissionedNodes(controller).map((node) => node.state.commissioning.deviceIdentifier ?? node.id));
    const discoveredNodes = await controller.peers.discover({ timeout: Seconds(12) });
    const discoveredById = new Map<string, MatterCommissionableNode>();

    for (const node of discoveredNodes) {
      const summary = summarizeDiscoveredNode(node, pairedDeviceIds.has(node.state.commissioning.deviceIdentifier ?? node.id));
      discoveredById.set(summary.deviceIdentifier, summary);
    }

    return [...discoveredById.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  }

  async commissionDevice(deviceIdentifier: string, pairingCode: string): Promise<void> {
    const controller = await this.getOnlineController();
    const parsed = this.parsePairingCode(pairingCode);
    const discoveryOptions: Record<string, unknown> = {
      timeout: Seconds(60),
    };
    const commissionOptions: Record<string, unknown> = {
      passcode: parsed.passcode,
      timeout: Seconds(60),
      autoSubscribe: false,
    };

    if (deviceIdentifier) {
      discoveryOptions.instanceId = deviceIdentifier;
    } else if (parsed.longDiscriminator !== undefined) {
      discoveryOptions.longDiscriminator = parsed.longDiscriminator;
    } else if (parsed.shortDiscriminator !== undefined) {
      discoveryOptions.shortDiscriminator = parsed.shortDiscriminator;
    }

    const node = await controller.peers.locate(discoveryOptions as never);
    const originalStart = node.start.bind(node);

    try {
      // Keep the freshly commissioned node from auto-subscribing; we only poll.
      node.start = async () => undefined;
      await node.commission(commissionOptions as never);
      this.disableAutoSubscribe(node);
    } finally {
      node.start = originalStart;
    }
  }

  async removeNode(nodeId: string): Promise<void> {
    const controller = await this.getOnlineController();
    const node = controller.peers.get(nodeId);
    if (!node) {
      throw new Error(`Matter node ${nodeId} is not paired anymore.`);
    }

    try {
      await node.decommission();
    } catch (error) {
      this.log.warn(`Failed to cleanly decommission ${getNodeName(node)}. Removing local pairing only.`);
      await node.delete();
      this.debug(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  }

  async buildUiSnapshot(options: { discover?: boolean } = {}): Promise<MatterUiSnapshot> {
    const controller = await this.getOnlineController();
    const collected: Record<keyof InventoryLists, Map<string, MatterOption>> = {
      temperatureSources: new Map(),
      humiditySources: new Map(),
      switchTargets: new Map(),
      contactSensors: new Map(),
    };

    // Commissionable discovery (fixed ~12s) runs while the paired nodes are being read.
    const discoveryPromise: Promise<MatterCommissionableNode[]> = options.discover === false
      ? Promise.resolve([])
      : this.discoverCommissionableNodes().catch((error) => {
        this.log.warn(`Matter discovery failed: ${errorMessage(error)}`);
        return [];
      });

    const pairedNodes = await Promise.all(this.getCommissionedNodes(controller).map(async (node) => {
      this.rememberNode(node);
      const base = {
        nodeId: node.id,
        deviceIdentifier: node.state.commissioning.deviceIdentifier ?? node.id,
        name: getNodeName(node),
        vendorId: this.getVendorId(node),
        productId: this.getProductId(node),
        addresses: (node.state.commissioning.addresses ?? []).map((address) => formatAddress(address)),
      };

      try {
        const inventory = await this.guard.run(
          node.id,
          `building the endpoint inventory of ${base.name}`,
          () => this.buildInventory(node),
          INVENTORY_TIMEOUT_MS,
        );

        for (const list of Object.keys(collected) as Array<keyof InventoryLists>) {
          for (const option of inventory[list]) {
            collected[list].set(referenceKey(option.reference), option);
          }
        }

        this.rememberNode(node);
        return {
          ...base,
          // The name is only known reliably after the structure read.
          name: inventory.nodeName,
          addresses: inventory.addresses,
          reachable: true,
          endpointsDiscovered: inventory.endpointsDiscovered,
          temperatureSources: inventory.temperatureSources.length,
          humiditySources: inventory.humiditySources.length,
          switchTargets: inventory.switchTargets.length,
          contactSensors: inventory.contactSensors.length,
        } satisfies MatterPairedNodeSummary;
      } catch (error) {
        return {
          ...base,
          reachable: false,
          error: this.describeNodeError(node.id, error),
          problem: this.problemFor(node.id),
          endpointsDiscovered: 0,
          temperatureSources: 0,
          humiditySources: 0,
          switchTargets: 0,
          contactSensors: 0,
        } satisfies MatterPairedNodeSummary;
      }
    }));

    const discoveredNodes = await discoveryPromise;

    const byLabel = (left: MatterOption, right: MatterOption) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
    const snapshot: MatterUiSnapshot = {
      discoveredNodes,
      pairedNodes: pairedNodes.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" })),
      temperatureSources: [...collected.temperatureSources.values()].sort(byLabel),
      humiditySources: [...collected.humiditySources.values()].sort(byLabel),
      switchTargets: [...collected.switchTargets.values()].sort(byLabel),
      contactSensors: [...collected.contactSensors.values()].sort(byLabel),
      warnings: ["matterOnly", "bridgeHint", "storageShared"] satisfies WarningCode[],
      cachedAt: new Date().toISOString(),
    };

    await this.writeUiSnapshotCache(snapshot).catch((error) => {
      this.debug(`Could not write Matter UI snapshot cache: ${errorMessage(error)}`);
    });

    return snapshot;
  }

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  private async readNodeReferences(
    nodeId: string,
    references: MatterEndpointReference[],
  ): Promise<Map<string, EndpointReadResult>> {
    const node = await this.getStartedNode(nodeId);
    const results = new Map<string, EndpointReadResult>();
    const requested: MatterEndpointReference[] = [];

    for (const reference of references) {
      const behavior = CLUSTER_BEHAVIORS[reference.clusterType];

      let hasBehavior = false;
      try {
        hasBehavior = node.endpoints.for(reference.endpointId).behaviors.has(behavior as never);
      } catch {
        hasBehavior = false;
      }

      if (!hasBehavior) {
        results.set(referenceKey(reference), {
          ok: false,
          error: `Endpoint ${reference.endpointId} on ${reference.nodeName} no longer exposes ${reference.clusterType}. Re-select it in the settings.`,
        });
        continue;
      }

      requested.push(reference);
    }

    if (!requested.length) {
      return results;
    }

    const raw = await this.readRemoteAttributes(node, requested.map((reference) => ({
      endpointId: reference.endpointId,
      ...CLUSTER_ATTRIBUTES[reference.clusterType],
    })));

    for (const reference of requested) {
      const { clusterId, attributeId } = CLUSTER_ATTRIBUTES[reference.clusterType];
      const entry = raw.get(`${reference.endpointId}/${clusterId}/${attributeId}`);
      results.set(referenceKey(reference), this.convertValue(reference, entry));
    }

    return results;
  }

  private convertValue(reference: MatterEndpointReference, entry: { value?: unknown; status?: number } | undefined): EndpointReadResult {
    if (!entry) {
      return { ok: false, error: `${describeReference(reference)} did not return a value.` };
    }

    if (entry.status !== undefined) {
      return { ok: false, error: `${describeReference(reference)} answered with Matter status ${entry.status}.` };
    }

    switch (reference.clusterType) {
      case "temperatureMeasurement":
        // MeasuredValue is nullable: null means "no reading yet".
        return typeof entry.value === "number" && Number.isFinite(entry.value)
          ? { ok: true, value: entry.value / 100 }
          : { ok: false, error: `${describeReference(reference)} has no temperature reading yet.` };
      case "relativeHumidityMeasurement":
        return typeof entry.value === "number" && Number.isFinite(entry.value)
          ? { ok: true, value: entry.value / 100 }
          : { ok: false, error: `${describeReference(reference)} has no humidity reading yet.` };
      case "booleanState":
        // Contact sensor: StateValue true = contact (closed). We report "open".
        return typeof entry.value === "boolean"
          ? { ok: true, value: !entry.value }
          : { ok: false, error: `${describeReference(reference)} has no readable state yet.` };
      case "onOff":
        return typeof entry.value === "boolean"
          ? { ok: true, value: entry.value }
          : { ok: false, error: `${describeReference(reference)} has no readable On/Off state yet.` };
    }
  }

  private async readRemoteAttributes(
    node: ClientNode,
    paths: Array<{ endpointId: number; clusterId: number; attributeId: number }>,
  ): Promise<Map<string, { value?: unknown; status?: number }>> {
    const readRequest = {
      includeKnownVersions: true,
      isFabricFiltered: true,
      interactionModelRevision: SessionParameters.defaults.interactionModelRevision,
      attributeRequests: paths,
    } as unknown as Parameters<ClientNode["interaction"]["read"]>[0];

    const wanted = new Set(paths.map((path) => `${path.endpointId}/${path.clusterId}/${path.attributeId}`));
    const values = new Map<string, { value?: unknown; status?: number }>();

    for await (const chunk of node.interaction.read(readRequest)) {
      for (const report of chunk as Iterable<ReadReport>) {
        const key = `${Number(report.path?.endpointId)}/${Number(report.path?.clusterId)}/${Number(report.path?.attributeId)}`;
        if (!wanted.has(key)) {
          continue;
        }

        if (report.kind === "attr-value") {
          values.set(key, { value: report.value });
        } else if (report.kind === "attr-status") {
          values.set(key, { status: Number(report.status) });
        }
      }
    }

    return values;
  }

  // ---------------------------------------------------------------------------------------------
  // Inventory (settings UI)
  // ---------------------------------------------------------------------------------------------

  private async buildInventory(node: ClientNode): Promise<MatterNodeInventory> {
    await this.startNode(node);
    await this.refreshNodeStructure(node);

    const nodeName = getNodeName(node);
    const vendorId = this.getVendorId(node);
    const productId = this.getProductId(node);
    const deviceIdentifier = node.state.commissioning.deviceIdentifier ?? node.id;
    const addresses = (node.state.commissioning.addresses ?? []).map((address) => formatAddress(address));
    const lists: InventoryLists = { temperatureSources: [], humiditySources: [], switchTargets: [], contactSensors: [] };

    for (const endpoint of node.endpoints) {
      if (endpoint.number === 0) {
        continue;
      }

      const endpointName = getEndpointName(endpoint);
      const common = {
        nodeId: node.id,
        deviceIdentifier,
        endpointId: endpoint.number,
        endpointName,
        deviceName: endpointName,
        nodeName,
        ...getEndpointIdentity(endpoint),
        deviceType: getEndpointDeviceType(endpoint),
        deviceTypes: getEndpointDeviceTypes(endpoint),
        vendorId,
        productId,
      };

      for (const kind of INVENTORY_KINDS) {
        if (!endpoint.behaviors.has(CLUSTER_BEHAVIORS[kind.clusterType] as never)) {
          continue;
        }

        const reference: MatterEndpointReference = { ...common, clusterType: kind.clusterType };
        lists[kind.list].push({ label: createOptionLabel(reference, kind.purpose), reference });
      }
    }

    return {
      nodeId: node.id,
      deviceIdentifier,
      nodeName,
      vendorId,
      productId,
      addresses,
      endpointsDiscovered: [...node.endpoints].filter((endpoint) => endpoint.number !== 0).length,
      ...lists,
    };
  }

  /**
   * Reads the whole node so node.endpoints reflects every endpoint without an auto-subscription.
   * Always done for the settings-page inventory: right after commissioning matter.js knows only
   * part of the structure, and bridges add or remove bridged devices over time.
   */
  private async refreshNodeStructure(node: ClientNode): Promise<void> {
    const readRequest = {
      includeKnownVersions: true,
      isFabricFiltered: true,
      interactionModelRevision: SessionParameters.defaults.interactionModelRevision,
      attributeRequests: [{}],
    } as unknown as Parameters<ClientNode["interaction"]["read"]>[0];

    const scannedEndpointIds = new Set<number>();
    const rootParts = new Set<number>();

    for await (const chunk of node.interaction.read(readRequest)) {
      for (const report of chunk as Iterable<ReadReport>) {
        if (report.kind !== "attr-value" || report.path === undefined) {
          continue;
        }

        const endpointId = Number(report.path.endpointId ?? 0);
        if (Number.isFinite(endpointId)) {
          scannedEndpointIds.add(endpointId);
        }

        if (
          endpointId === 0
          && Number(report.path.clusterId) === DESCRIPTOR_CLUSTER_ID
          && Number(report.path.attributeId) === PARTS_LIST_ATTRIBUTE_ID
          && Array.isArray(report.value)
        ) {
          for (const child of report.value) {
            const childId = Number(child);
            if (Number.isFinite(childId)) {
              rootParts.add(childId);
            }
          }
        }
      }
    }

    const sorted = (values: Iterable<number>) => [...values].filter((id) => id !== 0).sort((left, right) => left - right).join(", ") || "none";
    this.verboseInfo(
      `[${getNodeName(node)}] Matter raw scan endpoints: ${sorted(scannedEndpointIds)}; `
      + `root partsList: ${sorted(rootParts)}; `
      + `structured endpoints: ${sorted([...node.endpoints].map((endpoint) => endpoint.number))}.`,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Node handling
  // ---------------------------------------------------------------------------------------------

  private getCommissionedNodes(controller: ServerNode): ClientNode[] {
    return [...controller.peers].filter((node) => node.state.commissioning.peerAddress !== undefined);
  }

  private async getStartedNode(nodeId: string): Promise<ClientNode> {
    const controller = await this.getOnlineController();
    const node = controller.peers.get(nodeId);
    if (!node || node.state.commissioning.peerAddress === undefined) {
      throw new Error(`Matter node ${nodeId} is not paired anymore. Pair it again in the Vthermo settings.`);
    }

    this.rememberNode(node);
    await this.startNode(node);
    return node;
  }

  private async startNode(node: ClientNode): Promise<void> {
    this.disableAutoSubscribe(node);
    await this.applyAddressOverride(node);

    if (node.lifecycle.isOnline) {
      return;
    }

    try {
      await node.start();
    } catch (error) {
      if (this.isMissingMdnsScannerError(error)) {
        this.verboseWarn(`[${getNodeName(node)}] mDNS scanner was not ready yet, retrying node startup once.`);
        await this.wait(MDNS_SCANNER_SETTLE_MS);
        await node.start();
        return;
      }

      if (await this.recoverCachedOperationalAddress(node, error)) {
        await node.start();
        return;
      }

      throw error;
    }
  }

  private disableAutoSubscribe(node: ClientNode): void {
    if (node.state.network.autoSubscribe === false) {
      return;
    }

    (node.state.network as { autoSubscribe: boolean }).autoSubscribe = false;
  }

  private async applyAddressOverride(node: ClientNode): Promise<void> {
    const override = this.addressOverrides.get(node.id);
    if (!override) {
      return;
    }

    const stored = node.state.commissioning.addresses ?? [];
    const storedMatches = stored.length === 1 && this.isUdpAddress(stored[0]!) && ServerAddress.isEqual(stored[0]!, override);
    const live = this.getLivePeerOperationalAddress(node);
    const liveMatches = live === undefined || ServerAddress.isEqual(live, override);
    if (storedMatches && liveMatches) {
      return;
    }

    if (!storedMatches) {
      await this.persistCommissioningAddresses(node, [override]);
    }
    this.updateLivePeerOperationalAddress(node, override);
    this.log.info(`[${getNodeName(node)}] Using fixed Matter address ${ServerAddress.urlFor(override)}.`);
  }

  private getLivePeerOperationalAddress(node: ClientNode): ServerAddress | undefined {
    const peerAddress = node.state.commissioning.peerAddress;
    if (!node.owner || !peerAddress) {
      return undefined;
    }

    try {
      return node.owner.env.get(PeerSet).get(peerAddress)?.descriptor.operationalAddress;
    } catch {
      return undefined;
    }
  }

  private isMissingMdnsScannerError(error: unknown): boolean {
    return errorMessage(error).includes("Cannot discover device without mDNS scanner.");
  }

  private async withMdnsScannerRetry<T>(description: string, action: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        if (!this.isMissingMdnsScannerError(error) || attempt >= MDNS_SCANNER_RETRY_ATTEMPTS) {
          throw error;
        }

        const delayMs = MDNS_SCANNER_SETTLE_MS * (attempt + 1);
        this.verboseWarn(`Matter mDNS scanner was not ready while ${description}, retrying in ${(delayMs / 1000).toFixed(1)}s.`);
        await this.wait(delayMs);
      }
    }
  }

  private async getController(): Promise<ServerNode> {
    if (this.closed) {
      throw new Error("The Matter controller has been shut down.");
    }

    if (!this.controllerPromise) {
      this.controllerPromise = this.createController().catch((error) => {
        this.controllerPromise = undefined;
        throw error;
      });
    }

    const controller = await this.controllerPromise;
    for (const node of this.getCommissionedNodes(controller)) {
      this.disableAutoSubscribe(node);
      // Fixed addresses must be stored before the controller starts: matter.js loads each peer's
      // operational address from this state and immediately starts reconnecting to it.
      if (this.addressOverrides.has(node.id)) {
        await this.applyAddressOverride(node);
      } else {
        await this.prioritizeCachedOperationalAddresses(node);
      }
    }

    return controller;
  }

  private async getOnlineController(): Promise<ServerNode> {
    if (!this.controllerOnlinePromise) {
      this.controllerOnlinePromise = this.getController()
        .then(async (controller) => {
          await controller.start();
          await this.wait(MDNS_SCANNER_SETTLE_MS);
          return controller;
        })
        .catch((error) => {
          this.controllerOnlinePromise = undefined;
          throw error;
        });
    }

    return this.controllerOnlinePromise;
  }

  private async createController(): Promise<ServerNode> {
    const environment = NodeJsEnvironment();
    environment.vars.set("storage.path", join(this.storagePath, MATTER_STORAGE_DIRECTORY));
    environment.vars.set("storage.driver", "sqlite");

    const controllerType = ServerNode.RootEndpoint.with(ControllerBehavior);

    return ServerNode.create(controllerType, {
      id: MATTER_CONTROLLER_NODE_ID,
      environment,
      basicInformation: {
        vendorId: VendorId(0xfff1),
        vendorName: "palmaiz",
        productId: 0x0300,
        productName: "Vthermo Matter Controller",
        productLabel: "Vthermo Matter Controller",
        nodeLabel: "Homebridge Vthermo",
        serialNumber: "HBVTMCTRL-001",
        hardwareVersion: 1,
        hardwareVersionString: "1",
        softwareVersion: SOFTWARE_VERSION,
        softwareVersionString: PLUGIN_VERSION,
      },
      productDescription: {
        name: "Homebridge Vthermo",
      },
      controller: {
        adminFabricLabel: "Homebridge Vthermo",
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Operational address repair
  // ---------------------------------------------------------------------------------------------

  private async prioritizeCachedOperationalAddresses(node: ClientNode): Promise<void> {
    if (this.addressOverrides.has(node.id)) {
      return;
    }

    const currentAddresses = node.state.commissioning.addresses ?? [];
    if (currentAddresses.length < 2) {
      return;
    }

    const preferredAddresses = this.prioritizeOperationalAddresses(currentAddresses);
    const currentOperational = currentAddresses.find((address): address is ServerAddressUdp => this.isUdpAddress(address));
    const preferredOperational = preferredAddresses.find((address): address is ServerAddressUdp => this.isUdpAddress(address));

    if (!currentOperational || !preferredOperational || ServerAddress.isEqual(currentOperational, preferredOperational)) {
      return;
    }

    await this.persistCommissioningAddresses(node, preferredAddresses);
    this.verboseInfo(
      `[${getNodeName(node)}] Reordered cached operational addresses to prefer `
      + `${ServerAddress.urlFor(preferredOperational)} over ${ServerAddress.urlFor(currentOperational)}.`,
    );
  }

  private async recoverCachedOperationalAddress(node: ClientNode, error: unknown): Promise<boolean> {
    if (this.addressOverrides.has(node.id)) {
      return false;
    }

    const message = errorMessage(error);
    if (!message.includes("ENETUNREACH") && !message.includes("Network is unreachable")) {
      return false;
    }

    const currentAddresses = node.state.commissioning.addresses ?? [];
    const preferredAddresses = this.prioritizeOperationalAddresses(currentAddresses);
    const currentOperational = currentAddresses.find((address): address is ServerAddressUdp => this.isUdpAddress(address));
    const preferredOperational = preferredAddresses.find((address): address is ServerAddressUdp => this.isUdpAddress(address));

    if (preferredOperational && currentOperational && !ServerAddress.isEqual(currentOperational, preferredOperational)) {
      await this.persistCommissioningAddresses(node, preferredAddresses);
      this.updateLivePeerOperationalAddress(node, preferredOperational);
      this.verboseWarn(
        `[${getNodeName(node)}] Cached operational address ${ServerAddress.urlFor(currentOperational)} `
        + `was unreachable, retrying with ${ServerAddress.urlFor(preferredOperational)}.`,
      );
      return true;
    }

    if (currentOperational && this.isScopedLinkLocalAddress(currentOperational)) {
      await this.persistCommissioningAddresses(node, []);
      this.updateLivePeerOperationalAddress(node, undefined);
      this.verboseWarn(
        `[${getNodeName(node)}] Cached scoped link-local operational address `
        + `${ServerAddress.urlFor(currentOperational)} was unreachable, clearing it and retrying with discovery.`,
      );
      return true;
    }

    return false;
  }

  private prioritizeOperationalAddresses(addresses: readonly ServerAddress[]): ServerAddress[] {
    return addresses
      .map((address, index) => ({ address, index, priority: this.getOperationalAddressPriority(address) }))
      .sort((left, right) => left.priority - right.priority || left.index - right.index)
      .map(({ address }) => ({ ...address }));
  }

  private getOperationalAddressPriority(address: ServerAddress): number {
    if (!this.isUdpAddress(address)) {
      return 100;
    }

    const ip = address.ip.split("%", 1)[0]?.toLowerCase() ?? address.ip.toLowerCase();
    if (isIPv4(ip)) {
      return 0;
    }
    if (ip.startsWith("fc") || ip.startsWith("fd")) {
      return 10;
    }
    if (ip.startsWith("fe80:")) {
      return address.ip.includes("%") ? 40 : 30;
    }
    return 20;
  }

  private isScopedLinkLocalAddress(address: ServerAddress): address is ServerAddressUdp {
    return this.isUdpAddress(address) && address.ip.toLowerCase().startsWith("fe80:") && address.ip.includes("%");
  }

  private isUdpAddress(address: ServerAddress): address is ServerAddressUdp {
    return address.type === "udp" && typeof address.ip === "string" && typeof address.port === "number";
  }

  private async persistCommissioningAddresses(node: ClientNode, addresses: readonly ServerAddress[]): Promise<void> {
    type CommissioningAgent = {
      commissioning: { state: { addresses?: ServerAddress[] } };
      context: {
        transaction: {
          addResources: (resource: unknown) => Promise<void>;
          begin: () => Promise<void>;
          commit: () => Promise<void>;
        };
      };
    };

    const nextAddresses = addresses.map((address) => ({ ...address }));

    await node.act("repair-operational-addresses", async (agent) => {
      const commissioningAgent = agent as unknown as CommissioningAgent;
      await commissioningAgent.context.transaction.addResources(commissioningAgent.commissioning);
      await commissioningAgent.context.transaction.begin();
      commissioningAgent.commissioning.state.addresses = nextAddresses;
      await commissioningAgent.context.transaction.commit();
    });
  }

  private updateLivePeerOperationalAddress(node: ClientNode, address: ServerAddressUdp | undefined): void {
    const owner = node.owner;
    const peerAddress = node.state.commissioning.peerAddress;
    if (!owner || !peerAddress) {
      return;
    }

    try {
      const peer = owner.env.get(PeerSet).get(peerAddress);
      if (peer) {
        peer.descriptor.operationalAddress = address;
      }
    } catch (error) {
      this.debug(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  private parsePairingCode(input: string): PairingCodeDetails {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("Enter a Matter manual pairing code or an MT: QR pairing code.");
    }

    if (trimmed.toUpperCase().startsWith("MT:")) {
      const [payload] = QrPairingCodeCodec.decode(trimmed.toUpperCase());
      if (!payload) {
        throw new Error("The Matter QR pairing code could not be decoded.");
      }

      return { passcode: payload.passcode, longDiscriminator: payload.discriminator };
    }

    const manual = ManualPairingCodeCodec.decode(trimmed.replace(/\D/g, ""));
    return {
      passcode: manual.passcode,
      longDiscriminator: manual.discriminator,
      shortDiscriminator: manual.shortDiscriminator,
    };
  }

  private getVendorId(node: ClientNode): number | undefined {
    const value = node.maybeStateOf(BasicInformationClient)?.vendorId ?? node.state.commissioning.vendorId;
    return typeof value === "number" ? Number(value) : undefined;
  }

  private getProductId(node: ClientNode): number | undefined {
    const value = node.maybeStateOf(BasicInformationClient)?.productId ?? node.state.commissioning.productId;
    return typeof value === "number" ? value : undefined;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private debug(message: string): void {
    if (this.isVerbose()) {
      this.log.debug(message);
    }
  }

  private verboseInfo(message: string): void {
    if (this.isVerbose()) {
      this.log.info(message);
    }
  }

  private verboseWarn(message: string): void {
    if (this.isVerbose()) {
      this.log.warn(message);
    }
  }

  private async writeUiSnapshotCache(snapshot: MatterUiSnapshot): Promise<void> {
    const cachePath = MatterControllerClient.getUiSnapshotCachePath(this.storagePath);
    await mkdir(join(this.storagePath, MATTER_STORAGE_DIRECTORY), { recursive: true });
    // Write atomically so the settings page never reads a half-written file.
    const temporaryPath = `${cachePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(temporaryPath, cachePath);
  }

  private static getUiSnapshotCachePath(storagePath: string): string {
    return join(storagePath, MATTER_STORAGE_DIRECTORY, UI_SNAPSHOT_CACHE_FILE);
  }

  private static isUiSnapshot(value: unknown): value is MatterUiSnapshot {
    if (!value || typeof value !== "object") {
      return false;
    }

    const snapshot = value as Partial<Record<keyof MatterUiSnapshot, unknown>>;
    return Array.isArray(snapshot.discoveredNodes)
      && Array.isArray(snapshot.pairedNodes)
      && Array.isArray(snapshot.temperatureSources)
      && Array.isArray(snapshot.switchTargets)
      && Array.isArray(snapshot.contactSensors)
      && Array.isArray(snapshot.warnings);
  }
}
