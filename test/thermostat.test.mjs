import test from "node:test";
import assert from "node:assert/strict";

import * as hap from "@homebridge/hap-nodejs";

import { VthermoAccessory } from "../dist/thermostatAccessory.js";
import { RelayController } from "../dist/relay-controller.js";
import { referenceKey } from "../dist/matter-model.js";

const ref = (endpointId, clusterType, name) => ({
  nodeId: "hub", deviceIdentifier: "hub", endpointId, clusterType, endpointName: name, deviceName: name, nodeName: "Hub",
});
const sensorA = ref(1, "temperatureMeasurement", "Sensor A");
const sensorB = ref(2, "temperatureMeasurement", "Sensor B");
const windowSensor = ref(3, "booleanState", "Window");
const relayRef = ref(4, "onOff", "Relay");

const config = {
  id: "t1",
  name: "Test Thermostat",
  temperatureSources: [sensorA, sensorB],
  temperatureAggregation: "average",
  switchTarget: relayRef,
  contactSensors: [windowSensor],
  hysteresis: 0.5,
  checkIntervalSeconds: 30,
  relayRetryEnabled: false,
  relayRetryDelayMinutes: 5,
  defaultTargetTemperature: 21,
  minTargetTemperature: 10,
  maxTargetTemperature: 30,
};

function setup() {
  const values = new Map();
  const commands = [];
  const logs = { error: [], warn: [], info: [] };
  const client = {
    readEndpoints: async (references) => new Map(references.map((reference) => {
      const value = values.get(referenceKey(reference));
      return [referenceKey(reference), value instanceof Error
        ? { ok: false, error: value.message }
        : value === undefined ? { ok: false, error: "no value" } : { ok: true, value }];
    })),
    setSwitchState: async (_reference, enabled) => {
      commands.push(enabled);
      values.set(referenceKey(relayRef), enabled);
    },
  };
  const platform = {
    api: { hap, updatePlatformAccessories: () => undefined },
    log: {
      error: (m) => logs.error.push(m), warn: (m) => logs.warn.push(m), info: (m) => logs.info.push(m), debug: () => undefined,
    },
    controllerClient: client,
    debug: () => undefined,
  };
  const accessory = new hap.Accessory("Test", hap.uuid.generate("test-thermostat"));
  accessory.context = {};
  const relay = new RelayController(relayRef, client, { info: () => undefined, warn: () => undefined, debug: () => undefined });
  const thermostat = new VthermoAccessory(platform, accessory, config, relay);
  const service = accessory.getService(hap.Service.Thermostat);
  const value = (characteristic) => service.getCharacteristic(characteristic).value;

  return { values, commands, logs, thermostat, service, value, set: (reference, v) => values.set(referenceKey(reference), v) };
}

test("heats when the average is below the band and reports HEAT", async () => {
  const { set, thermostat, commands, value } = setup();
  set(sensorA, 20); set(sensorB, 20.4); set(windowSensor, false); set(relayRef, false);

  await thermostat.cycle();
  thermostat.pushState();

  assert.deepEqual(commands, [true]);
  assert.ok(Math.abs(value(hap.Characteristic.CurrentTemperature) - 20.2) < 1e-9);
  assert.equal(value(hap.Characteristic.CurrentHeatingCoolingState), hap.Characteristic.CurrentHeatingCoolingState.HEAT);
  assert.equal(value(hap.Characteristic.StatusFault), hap.Characteristic.StatusFault.NO_FAULT);
});

test("keeps working with one failed sensor and warns once", async () => {
  const { set, thermostat, commands, logs } = setup();
  set(sensorA, 19); set(sensorB, new Error("Sensor B timed out")); set(windowSensor, false); set(relayRef, false);

  await thermostat.cycle();
  await thermostat.cycle();

  assert.deepEqual(commands, [true]);
  assert.equal(logs.error.length, 0);
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /Sensor B timed out/);
});

test("an open window stops heating", async () => {
  const { set, thermostat, commands } = setup();
  set(sensorA, 19); set(sensorB, 19); set(windowSensor, false); set(relayRef, false);
  await thermostat.cycle();
  set(windowSensor, true);
  await thermostat.cycle();

  assert.deepEqual(commands, [true, false]);
});

test("no temperature at all is a fault and the relay is switched off", async () => {
  const { set, thermostat, commands, logs, value } = setup();
  set(sensorA, new Error("timeout")); set(sensorB, new Error("timeout")); set(windowSensor, false); set(relayRef, true);

  await thermostat.cycle();
  thermostat.pushState();

  assert.deepEqual(commands, [false]);
  assert.equal(logs.error.length, 1);
  assert.equal(value(hap.Characteristic.StatusFault), hap.Characteristic.StatusFault.GENERAL_FAULT);
});

test("HomeKit set handlers return immediately without Matter traffic", async () => {
  const { thermostat, service } = setup();
  let reads = 0;
  thermostat.platform.controllerClient.readEndpoints = async () => {
    reads += 1;
    return new Promise(() => undefined);
  };

  const started = Date.now();
  await service.getCharacteristic(hap.Characteristic.TargetTemperature).handleSetRequest(23);
  await service.getCharacteristic(hap.Characteristic.CurrentTemperature).handleGetRequest();
  assert.ok(Date.now() - started < 100);
  assert.equal(reads, 0);
  assert.equal(service.getCharacteristic(hap.Characteristic.TargetTemperature).value, 23);
  thermostat.stop();
});
