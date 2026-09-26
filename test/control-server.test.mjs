import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlServer } from "../dist/control-server.js";

test("control API requires the token, runs handlers one at a time and cleans up", async () => {
  const storage = await mkdtemp(join(tmpdir(), "vthermo-control-"));
  let active = 0;
  let maxActive = 0;
  const server = new ControlServer(storage, {
    "/echo": async (body) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { got: body.value };
    },
    "/fail": async () => { throw new Error("boom"); },
  }, { warn() {}, debug() {} });
  await server.start();

  const file = join(storage, "vthermo-matter", "control.json");
  const control = JSON.parse(await readFile(file, "utf8"));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const call = (path, token = control.token, body = {}) => fetch(`http://127.0.0.1:${control.port}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal((await call("/echo", "wrong")).status, 401);
  assert.equal((await call("/missing")).status, 404);
  const failed = await call("/fail");
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error, "boom");

  const [first, second] = await Promise.all([call("/echo", control.token, { value: 1 }), call("/echo", control.token, { value: 2 })]);
  assert.deepEqual((await first.json()).result, { got: 1 });
  assert.deepEqual((await second.json()).result, { got: 2 });
  assert.equal(maxActive, 1);

  await server.stop();
  await assert.rejects(stat(file));
});
