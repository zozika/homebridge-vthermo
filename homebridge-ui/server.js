import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { HomebridgePluginUiServer, RequestError } from "@homebridge/plugin-ui-utils";

import { MatterControllerClient } from "../dist/matter-client.js";
import { CONTROL_FILE, MATTER_STORAGE_DIRECTORY, STATUS_FILE } from "../dist/settings.js";

/** Pairing a large bridge can take a while; the running plugin answers when it is done. */
const BRIDGE_REQUEST_TIMEOUT_MS = 180_000;

const POST_COMMISSIONING_SETTLE_MS = 2500;

const uiLogger = {
  info: (message) => console.log(`[homebridge-vthermo] ${message}`),
  warn: (message) => console.warn(`[homebridge-vthermo] ${message}`),
  error: (message) => console.error(`[homebridge-vthermo] ${message}`),
  debug: () => undefined,
};

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function isBrokenPipeError(error) {
  return !!error && typeof error === "object" && "code" in error && error.code === "EPIPE";
}

function isAlreadyCommissionedError(error) {
  return messageOf(error).includes("already commissioned into this fabric");
}

/** The running Vthermo child bridge owns the Matter port and storage. */
function isMatterControllerBusyError(error) {
  const message = messageOf(error);
  return message.includes("port is already in use")
    || message.includes("EADDRINUSE")
    || message.includes("Matter controller is already active")
    || message.includes("database is locked")
    || message.includes("SQLITE_BUSY");
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else - still alive.
    return error?.code === "EPERM";
  }
}

function isConnectionRefused(error) {
  const code = error?.cause?.code ?? error?.code;
  return code === "ECONNREFUSED" || code === "ECONNRESET";
}

function requestError(code, message, status = 400) {
  return new RequestError(message, { status, code });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.queue = Promise.resolve();

    process.on("error", (error) => {
      if (isBrokenPipeError(error)) {
        console.warn("[homebridge-vthermo] UI IPC channel closed before Vthermo could reply.");
        return;
      }

      throw error;
    });

    this.onRequest("/bootstrap", (payload) => this.serialized(() => this.handleBootstrap(payload)));
    this.onRequest("/cached", () => this.serialized(() => this.handleCached()));
    // Reads a file written by the running plugin; never touches Matter, so it is not serialized.
    this.onRequest("/status", () => this.handleStatus());
    this.onRequest("/pair", (payload) => this.serialized(() => this.handlePair(payload)));
    this.onRequest("/unpair", (payload) => this.serialized(() => this.handleUnpair(payload)));

    this.ready();
  }

  /** Only one Matter controller may exist at a time, so requests run one after another. */
  serialized(work) {
    const run = this.queue.catch(() => undefined).then(work);
    this.queue = run;
    return run;
  }

  sendToUi(message) {
    if (typeof process.send !== "function" || !process.connected) {
      return false;
    }

    try {
      process.send(message, (error) => {
        if (error && !isBrokenPipeError(error)) {
          console.error(error);
        }
      });
      return true;
    } catch (error) {
      if (isBrokenPipeError(error)) {
        console.warn("[homebridge-vthermo] UI IPC send skipped because the pipe is already closed.");
        return false;
      }

      throw error;
    }
  }

  ready() {
    this.sendToUi({ action: "ready", payload: { server: true } });
  }

  sendResponse(request, data, success = true) {
    this.sendToUi({ action: "response", payload: { requestId: request.requestId, success, data } });
  }

  pushEvent(event, data) {
    this.sendToUi({ action: "stream", payload: { event, data } });
  }

  get storagePath() {
    if (!this.homebridgeStoragePath) {
      throw requestError("noStoragePath", "Homebridge storage path is not available.", 500);
    }

    return this.homebridgeStoragePath;
  }

  /**
   * Sends the request to the running Vthermo child bridge, which owns the Matter controller.
   * Returns undefined when the plugin is not running, so the caller can use its own controller.
   */
  async viaRunningPlugin(path, body = {}) {
    let control;
    try {
      control = JSON.parse(await readFile(join(this.storagePath, MATTER_STORAGE_DIRECTORY, CONTROL_FILE), "utf8"));
    } catch {
      return undefined;
    }

    if (!control?.port || !control?.token || !isProcessAlive(control.pid)) {
      return undefined;
    }

    let response;
    try {
      response = await fetch(`http://127.0.0.1:${control.port}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${control.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(BRIDGE_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (isConnectionRefused(error)) {
        return undefined;
      }
      throw error;
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new RequestError(data.error ?? `The running Vthermo plugin answered with HTTP ${response.status}.`, { status: response.status });
    }

    return { result: data.result };
  }

  async withClient(work) {
    const client = new MatterControllerClient({ log: uiLogger, storagePath: this.storagePath });

    try {
      return await work(client);
    } catch (error) {
      if (error instanceof RequestError) {
        throw error;
      }

      if (isMatterControllerBusyError(error)) {
        throw requestError(
          "controllerBusy",
          "The Matter controller is in use by the running Vthermo child bridge. Stop or restart the child bridge, then try again.",
          409,
        );
      }

      throw error;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async readCachedSnapshot() {
    const cached = await MatterControllerClient.readCachedUiSnapshot(this.storagePath).catch(() => undefined);
    if (!cached) {
      return undefined;
    }

    return {
      ...cached,
      fromCache: true,
      warnings: ["cachedSnapshot"],
    };
  }

  async handleStatus() {
    try {
      const raw = await readFile(join(this.storagePath, MATTER_STORAGE_DIRECTORY, STATUS_FILE), "utf8");
      const status = JSON.parse(raw);
      return { ...status, ageMs: Date.now() - Date.parse(status.updatedAt) };
    } catch {
      return null;
    }
  }

  /** Fast path for opening the page: show the last scan immediately, never touch Matter. */
  async handleCached() {
    return (await this.readCachedSnapshot()) ?? null;
  }

  async handleBootstrap() {
    const viaPlugin = await this.viaRunningPlugin("/snapshot", { discover: true });
    if (viaPlugin) {
      return viaPlugin.result;
    }

    try {
      return await this.withClient((client) => client.buildUiSnapshot());
    } catch (error) {
      if (!(error instanceof RequestError) || error.requestError?.code !== "controllerBusy") {
        throw error;
      }

      const cached = await this.readCachedSnapshot();
      if (!cached) {
        throw error;
      }

      return { ...cached, controllerBusy: true, warnings: ["controllerBusy"] };
    }
  }

  async handlePair(payload) {
    const deviceIdentifier = typeof payload?.deviceIdentifier === "string" ? payload.deviceIdentifier : "";
    const pairingCode = typeof payload?.pairingCode === "string" ? payload.pairingCode.trim() : "";

    if (!pairingCode) {
      throw requestError("missingPairingCode", "Enter the Matter manual pairing code or paste the MT: QR pairing code.");
    }

    const viaPlugin = await this.viaRunningPlugin("/pair", { deviceIdentifier, pairingCode });
    if (viaPlugin) {
      return viaPlugin.result;
    }

    return this.withClient(async (client) => {
      try {
        await client.commissionDevice(deviceIdentifier, pairingCode);
      } catch (error) {
        if (!isAlreadyCommissionedError(error)) {
          throw error;
        }
      }

      await wait(POST_COMMISSIONING_SETTLE_MS);
      return client.buildUiSnapshot();
    });
  }

  async handleUnpair(payload) {
    const nodeId = typeof payload?.nodeId === "string" ? payload.nodeId : "";
    if (!nodeId) {
      throw requestError("missingNodeId", "Missing paired Matter node id.");
    }

    const viaPlugin = await this.viaRunningPlugin("/unpair", { nodeId });
    if (viaPlugin) {
      return viaPlugin.result;
    }

    return this.withClient(async (client) => {
      await client.removeNode(nodeId);
      return client.buildUiSnapshot();
    });
  }
}

(() => new UiServer())();
