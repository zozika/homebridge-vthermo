// End-to-end check of the plugin's Matter client against test/e2e/virtual-device.mjs.
// Usage (device must be running): MATTER_MDNS_NETWORKINTERFACE=en0 node test/e2e/run.mjs
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MatterControllerClient } from "../../dist/matter-client.js";
import { referenceKey } from "../../dist/matter-model.js";

const device = (path) => fetch(`http://127.0.0.1:5599${path}`).then((response) => response.text());
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (name, value) => console.log("STEP", name, JSON.stringify(value));

const client = new MatterControllerClient({
  log: { info() {}, warn: (m) => console.log("WARN", m), error: (m) => console.log("ERR", m), debug() {} },
  storagePath: await mkdtemp(join(tmpdir(), "vthermo-e2e-")),
});

try {
  await client.start();
  await client.commissionDevice("", "34970112332");

  const snapshot = await client.buildUiSnapshot({ discover: false });
  const [node] = snapshot.pairedNodes;
  step("paired", node);
  assert.equal(node.name, "Test Hub");
  assert.equal(node.reachable, true);

  const temp = snapshot.temperatureSources[0].reference;
  const hum = snapshot.humiditySources[0].reference;
  const win = snapshot.contactSensors[0].reference;
  const relay = snapshot.switchTargets[0].reference;

  const values = [...(await client.readEndpoints([temp, hum, win, relay])).values()];
  step("read", values);
  assert.deepEqual(values, [{ ok: true, value: 19.5 }, { ok: true, value: 48.6 }, { ok: true, value: false }, { ok: true, value: false }]);

  await client.setSwitchState(relay, true);
  assert.equal(await device("/relay"), "true");

  const changes = [];
  const close = await client.subscribeToChanges(temp.nodeId, [win, relay], (key) => changes.push(key));
  await wait(3_000);
  changes.length = 0;
  const openedAt = Date.now();
  await device("/open");
  await wait(2_000);
  step("subscription", { windowReports: changes.filter((key) => key === referenceKey(win)).length, withinMs: Date.now() - openedAt });
  assert.ok(changes.includes(referenceKey(win)), "window change reported by subscription");
  close();
  await device("/close");

  await client.removeNode(temp.nodeId);
  assert.equal((await client.getPairedNodeIds()).size, 0);
  console.log("E2E OK");
} finally {
  await client.close();
}
process.exit(0);
