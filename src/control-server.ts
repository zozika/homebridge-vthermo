import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import { CONTROL_FILE, MATTER_STORAGE_DIRECTORY, PLUGIN_VERSION } from "./settings.js";

/**
 * Only one Matter controller can use the plugin's storage and port at a time. While the child
 * bridge runs, the settings page used to be locked out of pairing. The running plugin now offers
 * its controller through a tiny HTTP API bound to 127.0.0.1, protected by a random token that is
 * stored in a file only the Homebridge user can read. The settings page server (same host) uses it
 * and falls back to its own controller when the plugin is not running.
 */

export interface ControlFile {
  port: number;
  token: string;
  pid: number;
  version: string;
}

export type ControlHandler = (body: Record<string, unknown>) => Promise<unknown>;

const MAX_BODY_BYTES = 64 * 1024;

export class ControlServer {
  private server?: Server;
  private readonly token = randomBytes(32).toString("hex");
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    storagePath: string,
    private readonly handlers: Record<string, ControlHandler>,
    private readonly log: { warn(message: string): void; debug(message: string): void },
  ) {
    this.filePath = join(storagePath, MATTER_STORAGE_DIRECTORY, CONTROL_FILE);
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Control server did not get a TCP port.");
    }

    const content: ControlFile = { port: address.port, token: this.token, pid: process.pid, version: PLUGIN_VERSION };
    await mkdir(join(this.filePath, ".."), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(content), { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath);
    this.log.debug(`Settings-page control API listening on 127.0.0.1:${address.port}.`);
  }

  async stop(): Promise<void> {
    await rm(this.filePath, { force: true }).catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
    this.server = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    try {
      if (request.method !== "POST" || !this.isAuthorized(request.headers.authorization)) {
        send(request.method !== "POST" ? 405 : 401, { error: "Not allowed" });
        return;
      }

      const handler = this.handlers[request.url ?? ""];
      if (!handler) {
        send(404, { error: "Not found" });
        return;
      }

      const body = await this.readBody(request);
      // Matter operations on one controller must not overlap.
      const run = this.queue.catch(() => undefined).then(() => handler(body));
      this.queue = run;
      send(200, { result: await run });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`Settings-page request ${request.url ?? ""} failed: ${message}`);
      send(500, { error: message });
    }
  }

  private isAuthorized(header: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${this.token}`);
    const actual = Buffer.from(header ?? "");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        throw new Error("Request too large.");
      }
      chunks.push(chunk as Buffer);
    }

    if (!size) {
      return {};
    }

    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  }
}
