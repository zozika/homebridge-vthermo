// Regression: a controller restart with a sleepy (ICD) node whose stored autoSubscribe is true must
// start cleanly (2.3.6 failed with "This view is read-only").
// Usage: MATTER_MDNS_NETWORKINTERFACE=en0 VTHERMO_TEST_ICD=1 node test/e2e/virtual-device.mjs &
//        MATTER_MDNS_NETWORKINTERFACE=en0 node test/e2e/run-restart.mjs
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MatterControllerClient } from "../../dist/matter-client.js";

const log = { info() {}, warn: (m) => console.log("WARN", m), error: (m) => console.log("ERR", m), debug() {} };
const storagePath = await mkdtemp(join(tmpdir(), "vthermo-e2e-restart-"));

let client = new MatterControllerClient({ log, storagePath });
await client.start();
await client.commissionDevice("", "34970112332");
const snapshot = await client.buildUiSnapshot({ discover: false });
const win = snapshot.contactSensors[0].reference;
await client.enableIcdSubscription(win.nodeId, [win], () => undefined);
await new Promise((resolve) => setTimeout(resolve, 3_000));
await client.close();
console.log("STEP first run done");

client = new MatterControllerClient({ log, storagePath });
try {
  await client.start();
  console.log("STEP restart ok");
  const icd = await client.findIcdNodes([win.nodeId]);
  assert.ok(icd.has(win.nodeId));
  await client.enableIcdSubscription(win.nodeId, [win], () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const values = [...(await client.readEndpoints([win])).values()];
  console.log("STEP read after restart", JSON.stringify(values));
  assert.equal(values[0].ok, true);
  await client.removeNode(win.nodeId);
  console.log("E2E RESTART OK");
} finally {
  await client.close();
}
process.exit(0);
