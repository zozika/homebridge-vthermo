import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../homebridge-ui/public/i18n.js", import.meta.url), "utf8");
const context = {};
vm.runInNewContext(source, context);
const { en, hu } = context.VTHERMO_I18N;

test("English and Hungarian translations have the same keys", () => {
  assert.deepEqual(Object.keys(hu).sort(), Object.keys(en).sort());
});

test("translations keep the same placeholders", () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of Object.keys(en)) {
    assert.deepEqual(placeholders(hu[key]), placeholders(en[key]), key);
  }
});

test("every data-i18n key used in the page exists", async () => {
  const html = await readFile(new URL("../homebridge-ui/public/index.html", import.meta.url), "utf8");
  const keys = new Set([
    ...[...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]),
    ...[...html.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]),
    ...[...html.matchAll(/setStatus\("([^"]+)"/g)].map((match) => match[1]),
  ]);
  for (const key of keys) {
    assert.ok(key in en, `missing key ${key}`);
  }
});

test("every warning code produced by the plugin is translated", async () => {
  const codes = ["matterOnly", "bridgeHint", "storageShared", "cachedSnapshot", "controllerBusy", "viaBridge"];
  for (const code of codes) {
    assert.ok(`warning.${code}` in en, code);
  }
});

test("every demand reason and relay wait state has a label", () => {
  for (const reason of ["heat", "frost", "idle", "off", "window", "no-temperature"]) {
    assert.ok(`live.reason.${reason}` in en, reason);
  }
  for (const wait of ["min-on-wait", "min-off-wait", "cut-out-wait", "cut-out-no-retry"]) {
    assert.ok(`live.wait.${wait}` in en, wait);
  }
});
