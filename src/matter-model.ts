import type { ClientNode, Endpoint } from "@matter/main";
import { BasicInformationClient } from "@matter/main/behaviors/basic-information";
import { BridgedDeviceBasicInformationClient } from "@matter/main/behaviors/bridged-device-basic-information";
import { DescriptorClient } from "@matter/main/behaviors/descriptor";

export type MatterClusterType = "temperatureMeasurement" | "onOff" | "booleanState";

export interface MatterEndpointReference {
  nodeId: string;
  deviceIdentifier: string;
  endpointId: number;
  clusterType: MatterClusterType;
  endpointName: string;
  deviceName: string;
  nodeName: string;
  uniqueId?: string;
  serialNumber?: string;
  parentEndpointId?: number;
  parentEndpointName?: string;
  deviceType?: number;
  deviceTypes?: number[];
  vendorId?: number;
  productId?: number;
}

export interface MatterOption {
  label: string;
  reference: MatterEndpointReference;
}

export interface MatterNodeInventory {
  nodeId: string;
  deviceIdentifier: string;
  nodeName: string;
  vendorId?: number;
  productId?: number;
  addresses: string[];
  endpointsDiscovered: number;
  temperatureSources: MatterOption[];
  switchTargets: MatterOption[];
  contactSensors: MatterOption[];
}

export interface MatterPairedNodeSummary {
  nodeId: string;
  deviceIdentifier: string;
  name: string;
  vendorId?: number;
  productId?: number;
  addresses: string[];
  reachable: boolean;
  error?: string;
  endpointsDiscovered: number;
  temperatureSources: number;
  switchTargets: number;
  contactSensors: number;
}

export interface MatterCommissionableNode {
  deviceIdentifier: string;
  name: string;
  vendorId?: number;
  productId?: number;
  deviceType?: number;
  addresses: string[];
  paired: boolean;
}

type AddressLike = {
  type?: string;
  ip?: string;
  port?: number;
  peripheralAddress?: string;
};

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length ? value.trim() : undefined;
}

function shortenIdentifier(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

export function referenceKey(reference: MatterEndpointReference): string {
  return `${reference.nodeId}:${reference.endpointId}:${reference.clusterType}`;
}

export function formatAddress(address: AddressLike): string {
  if (address.type === "ble" && address.peripheralAddress) {
    return `ble://${address.peripheralAddress}`;
  }

  if (address.ip && typeof address.port === "number") {
    return `${address.ip}:${address.port}`;
  }

  if (address.ip) {
    return address.ip;
  }

  return address.type ?? "unknown";
}

function getBasicInformationName(node: ClientNode): string | undefined {
  const basicInformation = node.maybeStateOf(BasicInformationClient);
  // Aqara hubs report an empty nodeLabel; "" must fall through to the product name.
  return stringValue(basicInformation?.nodeLabel)
    ?? stringValue(basicInformation?.productName)
    ?? stringValue(node.state.commissioning.deviceName);
}

function getOwnEndpointName(endpoint: Endpoint): string {
  const bridged = endpoint.maybeStateOf(BridgedDeviceBasicInformationClient);
  const bridgedName = stringValue(bridged?.nodeLabel ?? bridged?.productName);
  if (bridgedName) {
    return bridgedName;
  }

  if (typeof endpoint.maybeId === "string" && endpoint.maybeId.trim().length) {
    return humanize(endpoint.maybeId.trim());
  }

  if (typeof endpoint.type.name === "string" && endpoint.type.name.trim().length) {
    return humanize(endpoint.type.name.trim());
  }

  return `Endpoint ${endpoint.number}`;
}

function getBridgedIdentityEndpoint(endpoint: Endpoint): Endpoint | undefined {
  let current: Endpoint | undefined = endpoint;

  while (current && current.number !== 0) {
    if (current.maybeStateOf(BridgedDeviceBasicInformationClient)) {
      return current;
    }

    current = current.owner;
  }

  return undefined;
}

function getBridgedDeviceName(endpoint: Endpoint): string | undefined {
  const bridgedEndpoint = getBridgedIdentityEndpoint(endpoint);
  const bridged = bridgedEndpoint?.maybeStateOf(BridgedDeviceBasicInformationClient);
  return stringValue(bridged?.nodeLabel ?? bridged?.productName);
}

export function getEndpointIdentity(
  endpoint: Endpoint,
): Pick<MatterEndpointReference, "uniqueId" | "serialNumber" | "parentEndpointId" | "parentEndpointName"> {
  const bridgedEndpoint = getBridgedIdentityEndpoint(endpoint);
  const bridged = bridgedEndpoint?.maybeStateOf(BridgedDeviceBasicInformationClient);
  const basic = endpoint.maybeStateOf(BasicInformationClient);
  const parentEndpointId = bridgedEndpoint && bridgedEndpoint.number !== endpoint.number
    ? Number(bridgedEndpoint.number)
    : undefined;

  return {
    uniqueId: stringValue(bridged?.uniqueId ?? basic?.uniqueId),
    serialNumber: stringValue(bridged?.serialNumber ?? basic?.serialNumber),
    parentEndpointId,
    parentEndpointName: parentEndpointId === undefined || !bridgedEndpoint ? undefined : getOwnEndpointName(bridgedEndpoint),
  };
}

export function getNodeName(node: ClientNode): string {
  const discoveredName = getBasicInformationName(node);
  if (typeof discoveredName === "string" && discoveredName.trim().length) {
    return discoveredName.trim();
  }

  return node.id;
}

export function getEndpointDeviceType(endpoint: Endpoint): number | undefined {
  return getEndpointDeviceTypes(endpoint)[0];
}

export function getEndpointDeviceTypes(endpoint: Endpoint): number[] {
  const descriptor = endpoint.maybeStateOf(DescriptorClient);
  return (descriptor?.deviceTypeList ?? [])
    .map((entry) => Number(entry.deviceType))
    .filter((deviceType) => Number.isFinite(deviceType));
}

export function getEndpointName(endpoint: Endpoint): string {
  const bridgedName = getBridgedDeviceName(endpoint);
  if (typeof bridgedName === "string" && bridgedName.trim().length) {
    return bridgedName.trim();
  }

  return getOwnEndpointName(endpoint);
}

export function createOptionLabel(
  reference: MatterEndpointReference,
  purpose: "temperature" | "switch" | "contact",
): string {
  const purposeLabel = purpose === "temperature"
    ? "Temperature"
    : purpose === "switch"
      ? "Switch"
      : "Contact";

  const parts = [reference.nodeName];

  if (reference.deviceName && reference.deviceName !== reference.nodeName) {
    parts.push(reference.deviceName);
  }

  if (reference.endpointName && reference.endpointName !== reference.deviceName) {
    parts.push(reference.endpointName);
  }

  const identifiers = [`ep ${reference.endpointId}`];
  if (reference.parentEndpointId !== undefined) {
    identifiers.push(`parent ${reference.parentEndpointId}`);
  }

  if (reference.uniqueId) {
    identifiers.push(`id ${shortenIdentifier(reference.uniqueId)}`);
  }

  if (reference.serialNumber) {
    identifiers.push(`sn ${shortenIdentifier(reference.serialNumber)}`);
  }

  parts.push(`${purposeLabel} (${identifiers.join(", ")})`);

  return parts.join(" / ");
}

export function describeReference(reference: MatterEndpointReference): string {
  return `${reference.nodeName} / ${reference.endpointName} / ${reference.clusterType}`;
}

export function summarizeDiscoveredNode(node: ClientNode, paired: boolean): MatterCommissionableNode {
  const state = node.state.commissioning;
  const addresses = (state.addresses ?? []).map((address) => formatAddress(address));

  return {
    deviceIdentifier: state.deviceIdentifier ?? node.id,
    name: getNodeName(node),
    vendorId: typeof state.vendorId === "number" ? Number(state.vendorId) : undefined,
    productId: typeof state.productId === "number" ? state.productId : undefined,
    deviceType: typeof state.deviceType === "number" ? state.deviceType : undefined,
    addresses,
    paired,
  };
}
