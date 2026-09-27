import test from "node:test";
import assert from "node:assert/strict";

import { installMatterCompatibilityPatches } from "../dist/matter-compat.js";
import { createOptionLabel } from "../dist/matter-model.js";
import { StatusCode } from "@matter/types/common";
import { TlvAttributeReport, TlvDataReport, TlvEventReport, TlvStatusResponse } from "@matter/types/protocol";
import { TlvArray, TlvBoolean, TlvEnum, TlvObject, TlvOptionalField, TlvUInt32, TlvUInt8 } from "@matter/types/tlv";

const TlvLenientDataReport = TlvObject({
  subscriptionId: TlvOptionalField(0, TlvUInt32),
  attributeReports: TlvOptionalField(1, TlvArray(TlvAttributeReport)),
  eventReports: TlvOptionalField(2, TlvArray(TlvEventReport)),
  moreChunkedMessages: TlvOptionalField(3, TlvBoolean),
  suppressResponse: TlvOptionalField(4, TlvBoolean),
  interactionModelRevision: TlvOptionalField(0xff, TlvUInt8),
});
const TlvLenientStatusResponse = TlvObject({
  status: TlvOptionalField(0, TlvEnum()),
  interactionModelRevision: TlvOptionalField(0xff, TlvUInt8),
});

test("accepts ReportData messages that omit interaction model revision", () => {
  const warnings = [];
  installMatterCompatibilityPatches({ warn: (message) => warnings.push(message) });

  const payload = TlvLenientDataReport.encode({
    attributeReports: [],
    suppressResponse: false,
  });

  // matter.js 0.17+ accepts this natively; older versions need the compatibility patch (warns once).
  const decoded = TlvDataReport.decode(payload);
  assert.equal(Array.isArray(decoded.attributeReports), true);
  assert.equal(decoded.attributeReports.length, 0);
  assert.ok(decoded.interactionModelRevision === undefined || typeof decoded.interactionModelRevision === "number");

  TlvDataReport.decode(payload);
  assert.ok(warnings.length <= 1);
});

test("accepts StatusResponse messages that omit interaction model revision", () => {
  installMatterCompatibilityPatches();

  const payload = TlvLenientStatusResponse.encode({
    status: StatusCode.Success,
  });

  const decoded = TlvStatusResponse.decode(payload);
  assert.equal(decoded.status, StatusCode.Success);
  assert.ok(decoded.interactionModelRevision === undefined || typeof decoded.interactionModelRevision === "number");
});

test("adds endpoint and unique id details to Matter option labels", () => {
  const label = createOptionLabel({
    nodeId: "peer1",
    deviceIdentifier: "0A2457F1DFF520BA",
    endpointId: 21,
    clusterType: "temperatureMeasurement",
    endpointName: "Aqara TVOC Air Quality Monitor",
    deviceName: "Aqara TVOC Air Quality Monitor",
    nodeName: "Aqara Hub M2",
    uniqueId: "00158d0009abcdef",
  }, "temperature");

  assert.match(label, /Aqara Hub M2/);
  assert.match(label, /Temperature \(ep 21, id 00158d\.\.\.abcdef\)/);
});

test("adds parent endpoint details to child endpoint labels", () => {
  const label = createOptionLabel({
    nodeId: "peer1",
    deviceIdentifier: "0A2457F1DFF520BA",
    endpointId: 202,
    clusterType: "booleanState",
    endpointName: "Front Door Sensor",
    deviceName: "Front Door Sensor",
    nodeName: "Aqara Hub M2",
    parentEndpointId: 201,
    uniqueId: "lumi.54ef4410005e15c3",
    serialNumber: "54ef4410005e15c3",
  }, "contact");

  assert.match(label, /Front Door Sensor/);
  assert.match(label, /Contact \(ep 202, parent 201, id lumi\.5\.\.\.5e15c3, sn 54ef44\.\.\.5e15c3\)/);
});

test("parses fixed Matter node addresses", async () => {
  const { parseAddressOverride } = await import("../dist/matter-client.js");

  assert.deepEqual(parseAddressOverride("192.168.1.68"), { type: "udp", ip: "192.168.1.68", port: 5540 });
  assert.deepEqual(parseAddressOverride("192.168.1.68:5541"), { type: "udp", ip: "192.168.1.68", port: 5541 });
  assert.deepEqual(parseAddressOverride("[fd21::1]:5540"), { type: "udp", ip: "fd21::1", port: 5540 });
  assert.deepEqual(parseAddressOverride("fd21::1"), { type: "udp", ip: "fd21::1", port: 5540 });
  assert.equal(parseAddressOverride("hub.local"), undefined);
  assert.equal(parseAddressOverride("192.168.1.68:99999"), undefined);
  assert.equal(parseAddressOverride(""), undefined);
});

test("recognises a device that lost our pairing from the matter.js log", async () => {
  const { MatterControllerClient } = await import("../dist/matter-client.js");
  const client = new MatterControllerClient({
    log: { info() {}, warn() {}, error() {}, debug() {} },
    storagePath: "/tmp/vthermo-test-does-not-exist",
  });
  client.peerKeys.set("peer1", "@1:1");
  client.nodeNames.set("peer1", "Aqara Hub M2");

  client.inspectMatterLog("PeerSet Failed to resume connection to @1:1 with udp://x: (Failure (1) / NoSharedTrustRoots (1)) Received general error status");
  assert.equal(client.problemFor("peer1"), "notPaired");
  assert.match(client.describeNodeError("peer1", new Error("not reachable")), /Aqara Hub M2 no longer accepts this controller/);
  assert.equal(client.problemFor("peer2"), undefined);
  await client.close();
});

test("tries the next device address quickly (matter.js 0.17 defaults to 45 s)", async () => {
  const { MatterControllerClient } = await import("../dist/matter-client.js");
  const { PeerTimingParameters } = await import("@matter/protocol");
  const client = new MatterControllerClient({ log: { info() {}, warn() {}, error() {}, debug() {} }, storagePath: "/tmp/vthermo-timing" });
  assert.equal(Number(PeerTimingParameters.defaults.delayBeforeNextAddress), 3_000);
  assert.equal(Number(PeerTimingParameters.defaults.delayAfterUnhandledError), 30_000);

  client.setAddressOverrides([{ nodeId: "peer1", address: "192.168.120.10" }]);
  client.moveAddressOverride("peer1", "peer2");
  assert.equal(client.addressOverrides.get("peer2").ip, "192.168.120.10");
  await client.close();
});
