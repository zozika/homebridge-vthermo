import test from "node:test";
import assert from "node:assert/strict";

import { resolvePlatformConfig } from "../dist/config.js";

function makeReference(overrides = {}) {
  return {
    nodeId: "aqara-m2-bridge",
    deviceIdentifier: "Aqara-Hub-M2-7DCE",
    endpointId: 2,
    clusterType: "temperatureMeasurement",
    endpointName: "Toilet Sensor",
    deviceName: "Toilet Sensor",
    nodeName: "Aqara M2",
    deviceType: 770,
    vendorId: 4447,
    productId: 4097,
    ...overrides,
  };
}

test("resolves multiple native thermostats from the thermostats array", () => {
  const result = resolvePlatformConfig({
    platform: "VthermoPlatform",
    thermostats: [
      {
        id: "toilet",
        name: "Toilet Thermostat",
        temperatureSources: [makeReference()],
        switchTarget: makeReference({
          endpointId: 8,
          clusterType: "onOff",
          endpointName: "Radiator Relay",
          deviceName: "Radiator Relay",
        }),
        contactSensors: [
          makeReference({
            endpointId: 12,
            clusterType: "booleanState",
            endpointName: "Window Sensor",
            deviceName: "Window Sensor",
            deviceType: 21,
          }),
        ],
      },
      {
        id: "hall",
        name: "Hall Thermostat",
        temperatureSources: [makeReference({
          endpointId: 5,
          endpointName: "Hall Sensor",
          deviceName: "Hall Sensor",
        })],
        switchTarget: makeReference({
          endpointId: 9,
          clusterType: "onOff",
          endpointName: "Hall Heater",
          deviceName: "Hall Heater",
        }),
      },
    ],
  });

  assert.equal(result.invalidThermostats.length, 0);
  assert.equal(result.thermostats.length, 2);
  assert.equal(result.thermostats[0].id, "toilet");
  assert.equal(result.thermostats[1].switchTarget.clusterType, "onOff");
});

test("keeps relay retry settings on resolved thermostats", () => {
  const result = resolvePlatformConfig({
    platform: "VthermoPlatform",
    thermostats: [
      {
        id: "boiler",
        name: "Boiler Thermostat",
        temperatureSources: [makeReference()],
        switchTarget: makeReference({
          endpointId: 8,
          clusterType: "onOff",
          endpointName: "Boiler Relay",
          deviceName: "Boiler Relay",
        }),
        relayRetryEnabled: true,
        relayRetryDelayMinutes: 12,
      },
    ],
  });

  assert.equal(result.invalidThermostats.length, 0);
  assert.equal(result.thermostats.length, 1);
  assert.equal(result.thermostats[0].relayRetryEnabled, true);
  assert.equal(result.thermostats[0].relayRetryDelayMinutes, 12);
});

test("accepts the deprecated temperature refresh interval without failing", () => {
  const result = resolvePlatformConfig({
    platform: "VthermoPlatform",
    thermostats: [
      {
        id: "refresh",
        name: "Refresh Thermostat",
        temperatureSources: [makeReference()],
        switchTarget: makeReference({
          endpointId: 8,
          clusterType: "onOff",
          endpointName: "Boiler Relay",
          deviceName: "Boiler Relay",
        }),
        temperatureRefreshIntervalMinutes: 9,
      },
    ],
  });

  assert.equal(result.invalidThermostats.length, 0);
  assert.equal(result.thermostats.length, 1);
  assert.equal("temperatureRefreshIntervalMinutes" in result.thermostats[0], false);
});

test("keeps a usable target range when min and max are equal", () => {
  const result = resolvePlatformConfig({
    platform: "VthermoPlatform",
    thermostats: [{
      id: "narrow",
      name: "Narrow",
      temperatureSources: [makeReference()],
      switchTarget: makeReference({ endpointId: 8, clusterType: "onOff" }),
      minTargetTemperature: 35,
      maxTargetTemperature: 35,
    }],
  });

  const [thermostat] = result.thermostats;
  assert.ok(thermostat.maxTargetTemperature > thermostat.minTargetTemperature);
  assert.ok(thermostat.maxTargetTemperature <= 35);
});

test("resolves node address overrides and drops incomplete entries", () => {
  const result = resolvePlatformConfig({
    platform: "VthermoPlatform",
    nodeAddressOverrides: [
      { nodeId: "peer1", address: " 192.168.110.20 " },
      { nodeId: "peer2", address: "" },
      { address: "10.0.0.1" },
    ],
  });

  assert.deepEqual(result.addressOverrides, [{ nodeId: "peer1", address: "192.168.110.20" }]);
});

test("marks thermostats without temperature sources as invalid", () => {
  const result = resolvePlatformConfig({
    platform: "VthermoPlatform",
    thermostats: [
      {
        id: "broken",
        name: "Broken Thermostat",
        switchTarget: makeReference({
          clusterType: "onOff",
          endpointName: "Radiator Relay",
          deviceName: "Radiator Relay",
        }),
      },
    ],
  });

  assert.equal(result.thermostats.length, 0);
  assert.equal(result.invalidThermostats.length, 1);
  assert.match(result.invalidThermostats[0].errors.join(" "), /Missing temperature sources/);
});

test("legacy Homebridge references produce a migration error", () => {
  const result = resolvePlatformConfig({
    platform: "VthermoPlatform",
    thermostats: [
      {
        id: "legacy",
        name: "Legacy Thermostat",
        temperatureSources: [
          {
            uniqueId: "legacy-service",
            characteristicType: "CurrentTemperature",
            serviceName: "Sensor",
          },
        ],
        switchTarget: {
          uniqueId: "legacy-switch",
          characteristicType: "On",
          serviceName: "Switch",
        },
      },
    ],
  });

  assert.equal(result.thermostats.length, 0);
  assert.equal(result.invalidThermostats.length, 1);
  assert.match(result.invalidThermostats[0].errors.join(" "), /Legacy Homebridge/);
});

test("native HomeKit references produce a Matter migration error", () => {
  const result = resolvePlatformConfig({
    platform: "VthermoPlatform",
    thermostats: [
      {
        id: "native-homekit",
        name: "Native HomeKit Thermostat",
        temperatureSources: [
          {
            controllerId: "native-controller",
            deviceId: "native-device",
            accessoryId: 2,
            serviceId: 3,
            characteristicId: 4,
            characteristicType: "CurrentTemperature",
            serviceName: "Temperature Sensor",
            accessoryName: "Temperature Sensor",
            controllerName: "Native HomeKit",
          },
        ],
        switchTarget: makeReference({
          clusterType: "onOff",
          endpointName: "Radiator Relay",
          deviceName: "Radiator Relay",
        }),
      },
    ],
  });

  assert.equal(result.thermostats.length, 0);
  assert.equal(result.invalidThermostats.length, 1);
  assert.match(result.invalidThermostats[0].errors.join(" "), /Native HomeKit/);
});
