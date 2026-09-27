import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { findRebindTarget, rebindInPlace } from "../dist/rebind.js";

const context = {};
vm.runInNewContext(await readFile(new URL("../homebridge-ui/public/rebind.js", import.meta.url), "utf8"), context);
const implementations = { runtime: findRebindTarget, ui: context.VthermoRebind.findRebindTarget };

const ref = (nodeId, endpointId, clusterType, extra = {}) => ({
  nodeId, deviceIdentifier: nodeId, endpointId, clusterType, endpointName: `ep${endpointId}`, deviceName: "d", nodeName: "Hub", ...extra,
});
const option = (reference) => ({ label: reference.endpointName, reference });
const paired = new Set(["peer2"]);

for (const [name, find] of Object.entries(implementations)) {
  test(`${name}: moves a reference to the re-paired node by unique id and keeps the offset`, () => {
    const old = ref("peer1", 202, "temperatureMeasurement", { uniqueId: "lumi.1", offset: -0.5 });
    const options = [option(ref("peer2", 261, "temperatureMeasurement", { uniqueId: "lumi.1" })), option(ref("peer2", 262, "relativeHumidityMeasurement", { uniqueId: "lumi.1" }))];
    const target = find(old, options, paired);
    assert.equal(target.nodeId, "peer2");
    assert.equal(target.endpointId, 261);
    assert.equal(target.offset, -0.5);
  });

  test(`${name}: leaves references on paired nodes alone`, () => {
    assert.equal(find(ref("peer2", 1, "onOff", { uniqueId: "x" }), [], paired), undefined);
  });

  test(`${name}: uses the endpoint name when a device has several matching endpoints`, () => {
    const old = ref("peer1", 77, "onOff", { uniqueId: "sw", endpointName: "Left" });
    const options = [
      option(ref("peer2", 213, "onOff", { uniqueId: "sw", endpointName: "Left" })),
      option(ref("peer2", 214, "onOff", { uniqueId: "sw", endpointName: "Right" })),
    ];
    assert.equal(find(old, options, paired).endpointId, 213);
  });

  test(`${name}: gives up when the match is ambiguous or there is no identifier`, () => {
    const options = [option(ref("peer2", 1, "onOff", { uniqueId: "sw", endpointName: "A" })), option(ref("peer2", 2, "onOff", { uniqueId: "sw", endpointName: "A" }))];
    assert.equal(find(ref("peer1", 9, "onOff", { uniqueId: "sw", endpointName: "A" }), options, paired), undefined);
    assert.equal(find(ref("peer1", 9, "onOff"), options, paired), undefined);
  });
}

test("rebindInPlace updates the shared object and counts changes", () => {
  const old = ref("peer1", 202, "temperatureMeasurement", { serialNumber: "sn1" });
  const holder = [old];
  const changed = rebindInPlace([old, undefined], [option(ref("peer2", 5, "temperatureMeasurement", { serialNumber: "sn1" }))], paired);
  assert.equal(changed, 1);
  assert.equal(holder[0].nodeId, "peer2");
  assert.equal(holder[0].endpointId, 5);
});

test("rebindInPlace reports which node ids moved", () => {
  const moves = new Map();
  rebindInPlace([ref("peer1", 1, "onOff", { uniqueId: "r" })], [option(ref("peer2", 7, "onOff", { uniqueId: "r" }))], paired, moves);
  assert.deepEqual([...moves], [["peer1", "peer2"]]);
});
