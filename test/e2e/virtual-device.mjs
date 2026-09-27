// Virtual Matter test device for end-to-end tests: thermometer, humidity sensor, window (contact)
// sensor and a relay on one node. Manual pairing code: 34970112332.
// A small HTTP API on 127.0.0.1:5599 lets tests open/close the window and read the relay.
//
// Usage: MATTER_MDNS_NETWORKINTERFACE=en0 node test/e2e/virtual-device.mjs
// VTHERMO_TEST_ICD=1 makes it a sleepy (ICD) device with a 17 s idle mode, like IKEA MYGGBETT.
// (restrict mDNS to a real interface; VPN/utun interfaces break local commissioning on macOS)
import { createServer } from "node:http";

import { Endpoint, Logger, LogLevel, ServerNode } from "@matter/main";
import { IcdManagementServer } from "@matter/main/behaviors/icd-management";
import { ContactSensorDevice, HumiditySensorDevice, OnOffPlugInUnitDevice, TemperatureSensorDevice } from "@matter/main/devices";
import "@matter/nodejs";

Logger.level = LogLevel.WARN;

const icd = process.env.VTHERMO_TEST_ICD === "1";
const rootType = icd ? ServerNode.RootEndpoint.with(IcdManagementServer) : ServerNode.RootEndpoint;

const node = await ServerNode.create(rootType, {
  ...(icd ? { icdManagement: { idleModeDuration: 17, activeModeDuration: 2_500, activeModeThreshold: 1_000, maximumCheckInBackoff: 17 } } : {}),
  id: process.env.VTHERMO_TEST_DEVICE_ID ?? "vthermo-test-device",
  network: { port: 5541 },
  commissioning: { passcode: 20202021, discriminator: 3840 },
  productDescription: { name: "Vthermo Test Device", deviceType: 0x0302 },
  // Empty nodeLabel like Aqara hubs, to exercise the product-name fallback.
  basicInformation: { vendorName: "Test", vendorId: 0xfff1, productName: "Test Hub", productId: 0x8000, nodeLabel: "", serialNumber: "TEST-1", uniqueId: "test-unique-1" },
});

const contact = new Endpoint(ContactSensorDevice, { id: "window", booleanState: { stateValue: true } });
const relay = new Endpoint(OnOffPlugInUnitDevice, { id: "relay", onOff: { onOff: false } });
await node.add(new Endpoint(TemperatureSensorDevice, { id: "temp", temperatureMeasurement: { measuredValue: 1950 } }));
await node.add(new Endpoint(HumiditySensorDevice, { id: "hum", relativeHumidityMeasurement: { measuredValue: 4860 } }));
await node.add(contact);
await node.add(relay);

createServer(async (request, response) => {
  if (request.url === "/open") {
    await contact.set({ booleanState: { stateValue: false } });
  } else if (request.url === "/close") {
    await contact.set({ booleanState: { stateValue: true } });
  } else if (request.url === "/relay") {
    response.end(String(relay.state.onOff.onOff));
    return;
  }
  response.end("ok");
}).listen(5599, "127.0.0.1");

await node.start();
console.log("DEVICE ready", icd ? "(ICD)" : "", JSON.stringify(node.state.commissioning.pairingCodes));
