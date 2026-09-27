import test from "node:test";
import assert from "node:assert/strict";

import { detectIcd, icdTimeoutMs } from "../dist/matter-client.js";
import { hasRoutableIpv6, hasSpecificRoute, ipv6ToBigInt, parseIpv6Routes } from "../dist/network-diagnostics.js";
import { NodeGuard, OperationTimeoutError } from "../dist/node-guard.js";

test("detects sleepy devices from the idle interval or the IcdManagement cluster", () => {
  // IKEA MYGGBETT: SII=17000 SAI=2500 SAT=1000
  assert.deepEqual(detectIcd({ idleIntervalMs: 17_000, activeIntervalMs: 2_500, activeThresholdMs: 1_000 }), {
    idleIntervalMs: 17_000, activeIntervalMs: 2_500, activeThresholdMs: 1_000, idleModeDurationMs: undefined, lit: undefined,
  });
  assert.equal(detectIcd({ serverList: [0x1d, 0x46] }).idleModeDurationMs, undefined);
  assert.equal(detectIcd({ serverList: [0x46], idleModeDurationSec: 300, lit: true }).idleModeDurationMs, 300_000);
  // Aqara hub: SII 500 ms, no ICD cluster
  assert.equal(detectIcd({ idleIntervalMs: 500, serverList: [0x1d, 0x28] }), undefined);
});

test("sleepy devices get timeouts long enough for a full idle interval", () => {
  assert.equal(icdTimeoutMs(20_000, undefined), 20_000);
  assert.equal(icdTimeoutMs(20_000, { idleIntervalMs: 17_000 }), 30_500);
  assert.equal(icdTimeoutMs(90_000, { idleIntervalMs: 17_000 }), 90_000);
  assert.equal(icdTimeoutMs(20_000, { idleModeDurationMs: 300_000 }), 455_000);
});

test("a timeout on a sleepy device does not put the node into backoff", async () => {
  const guard = new NodeGuard({ timeoutMs: 30, baseBackoffMs: 1_000, maxBackoffMs: 4_000 });
  await assert.rejects(guard.run("icd", "slow", () => new Promise(() => undefined), 30, false), OperationTimeoutError);
  assert.equal(guard.isBlocked("icd"), false);
  await assert.rejects(guard.run("icd", "network", async () => { throw new Error("ENETUNREACH"); }, 30, false));
  assert.equal(guard.isBlocked("icd"), true);
});

const ROUTES = [
  // fd54:8059:d3e:110::/64 dev br0
  "fd5480590d3e01100000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000001 00000000 00000001      br0",
  // default route
  "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe80000000000000aa9c6cfffe8c9c4d 00000400 00000003 00000000 00000003      br0",
  "00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000002 00000000 80200001       lo",
].join("\n");

test("parses /proc/net/ipv6_route and finds specific routes", () => {
  const routes = parseIpv6Routes(ROUTES);
  assert.equal(routes.length, 3);
  assert.equal(routes[0].prefixLength, 64);
  assert.equal(hasSpecificRoute("fd54:8059:d3e:110::5", routes), true);
  // A Thread OMR prefix reachable only via the default route: the missing RIO case.
  assert.equal(hasSpecificRoute("fd12:3456:789a:1:2:3:4:5", routes), false);
  assert.equal(ipv6ToBigInt("::1"), 1n);
  assert.equal(ipv6ToBigInt("192.168.1.1"), undefined);
});

test("checks for a routable IPv6 address on real interfaces only", () => {
  const v6 = (address) => ({ address, family: "IPv6", internal: false, netmask: "", mac: "", cidr: null, scopeid: 0 });
  assert.equal(hasRoutableIpv6({ br0: [v6("fe80::1")], docker0: [v6("fd00::1")] }), false);
  assert.equal(hasRoutableIpv6({ br0: [v6("fe80::1"), v6("fd54:8059:d3e:110::5")] }), true);
  assert.equal(hasRoutableIpv6({ br0: [v6("fe80::1")], eth1: [v6("2001:db8::1")] }, "br0"), false);
});
