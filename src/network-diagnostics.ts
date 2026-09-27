import { readFile } from "node:fs/promises";
import { isIPv6 } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

/**
 * Host network checks for Matter over Thread. A Thread device's operational address lives in the
 * Thread network's OMR prefix; the host only has a route to it if it accepted the border routers'
 * Route Information Option (Linux: net.ipv6.conf.<if>.accept_ra_rt_info_max_plen >= 64). Without
 * that route every packet goes to the default gateway, which does not know the Thread prefix.
 */

export interface Ipv6Route {
  /** 128-bit destination as a bigint. */
  destination: bigint;
  prefixLength: number;
  interfaceName: string;
}

/** Interfaces that never carry Matter traffic to real devices. */
const VIRTUAL_INTERFACE = /^(lo|docker\d*|br-[0-9a-f]+|veth|lxcbr\d*|lxdbr\d*|virbr\d*|utun\d*|tun\d*|tap\d*)/;

export function ipv6ToBigInt(address: string): bigint | undefined {
  const plain = address.split("%", 1)[0] ?? "";
  if (!isIPv6(plain)) {
    return undefined;
  }

  const [head = "", tail] = plain.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = tail === undefined ? headParts : [...headParts, ...Array(missing).fill("0"), ...tailParts];
  if (parts.length !== 8) {
    return undefined;
  }

  return parts.reduce((value, part) => (value << 16n) | BigInt(Number.parseInt(part || "0", 16)), 0n);
}

/** Parses /proc/net/ipv6_route (Linux). Lines: dest(32 hex) plen src splen nexthop metric refcnt use flags ifname. */
export function parseIpv6Routes(text: string): Ipv6Route[] {
  const routes: Ipv6Route[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || !/^[0-9a-f]{32}$/i.test(fields[0]!)) {
      continue;
    }
    routes.push({
      destination: BigInt(`0x${fields[0]}`),
      prefixLength: Number.parseInt(fields[1]!, 16),
      interfaceName: fields[9]!,
    });
  }
  return routes;
}

/** A route more specific than the default route covers the address (loopback excluded). */
export function hasSpecificRoute(address: string, routes: readonly Ipv6Route[]): boolean {
  const value = ipv6ToBigInt(address);
  if (value === undefined) {
    return true;
  }

  return routes.some((route) => {
    if (route.prefixLength === 0 || route.interfaceName === "lo") {
      return false;
    }
    const shift = BigInt(128 - route.prefixLength);
    return (value >> shift) === (route.destination >> shift);
  });
}

/** True if any real (non-virtual) interface has a routable IPv6 address (ULA or global). */
export function hasRoutableIpv6(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, only?: string): boolean {
  return Object.entries(interfaces).some(([name, addresses]) => {
    if ((only && name !== only) || (!only && VIRTUAL_INTERFACE.test(name))) {
      return false;
    }
    return (addresses ?? []).some((address) => address.family === "IPv6" && !address.internal && !address.address.toLowerCase().startsWith("fe80:"));
  });
}

export function isVirtualInterface(name: string): boolean {
  return VIRTUAL_INTERFACE.test(name);
}

export async function readIpv6Routes(): Promise<Ipv6Route[] | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    return parseIpv6Routes(await readFile("/proc/net/ipv6_route", "utf8"));
  } catch {
    return undefined;
  }
}
