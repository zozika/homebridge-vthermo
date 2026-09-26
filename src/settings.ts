import { readFileSync } from "node:fs";

export const PLATFORM_NAME = "VthermoPlatform";
export const PLUGIN_NAME = "homebridge-vthermo";
export const MATTER_CONTROLLER_NODE_ID = "vthermo-matter-controller";
export const MATTER_STORAGE_DIRECTORY = "vthermo-matter";

function readPluginVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const PLUGIN_VERSION = readPluginVersion();
