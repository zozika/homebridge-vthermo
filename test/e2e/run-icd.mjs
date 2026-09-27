// End-to-end check for sleepy (ICD) devices against the virtual device in ICD mode.
// Usage:
//   MATTER_MDNS_NETWORKINTERFACE=en0 VTHERMO_TEST_ICD=1 node test/e2e/virtual-device.mjs &
//   MATTER_MDNS_NETWORKINTERFACE=en0 node test/e2e/run-icd.mjs
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
  log: { info: (m) => console.log("INFO", m), warn: (m) => console.log("WARN", m), error: (m) => console.log("ERR", m), debug() {} },
  storagePath: await mkdtemp(join(tmpdir(), "vthermo-e2e-icd-")),
});

try {
  await client.start();
  const pairStart = Date.now();
  await client.commissionDevice("", "34970112332");
  step("paired in ms", Date.now() - pairStart);

  const snapshot = await client.buildUiSnapshot({ discover: false });
  const [node] = snapshot.pairedNodes;
  step("node", { name: node.name, reachable: node.reachable, icd: node.icd });
  assert.ok(node.icd, "virtual device recognised as sleepy (ICD)");

  const win = snapshot.contactSensors[0].reference;
  const temp = snapshot.temperatureSources[0].reference;
  const icdNodes = await client.findIcdNodes([win.nodeId]);
  assert.ok(icdNodes.has(win.nodeId));

  // Count real network reads: sleepy devices must be served from the subscription only.
  let networkReads = 0;
  const originalRead = client.readRemoteAttributes.bind(client);
  client.readRemoteAttributes = (...args) => { networkReads += 1; return originalRead(...args); };

  const changes = [];
  await client.enableIcdSubscription(win.nodeId, [win, temp], (key) => changes.push({ key, at: Date.now() }));
  for (let i = 0; i < 30 && !client.getNodeStatuses().find((status) => status.nodeId === win.nodeId)?.subscriptionAlive; i++) {
    await wait(500);
  }
  step("status", client.getNodeStatuses().find((status) => status.nodeId === win.nodeId));

  let values = [...(await client.readEndpoints([win, temp])).values()];
  step("read (closed)", values);
  assert.equal(values[0].ok && values[0].value, false);
  assert.equal(values[1].ok && values[1].value, 19.5);

  changes.length = 0;
  const openedAt = Date.now();
  await device("/open");
  while (!changes.some((change) => change.key === referenceKey(win)) && Date.now() - openedAt < 10_000) {
    await wait(100);
  }
  const reportMs = changes.find((change) => change.key === referenceKey(win))?.at - openedAt;
  values = [...(await client.readEndpoints([win])).values()];
  step("window open", { reportMs, value: values[0] });
  assert.ok(reportMs <= 5_000, "window change within 5 s");
  assert.equal(values[0].ok && values[0].value, true);
  assert.equal(networkReads, 0, "no polling reads on a sleepy device");

  await device("/close");
  await client.removeNode(win.nodeId);
  console.log("E2E ICD OK");
} finally {
  await client.close();
}
process.exit(0);
