declare module "fakegato-history" {
  import type { API, PlatformAccessory, Service } from "homebridge";

  interface FakeGatoOptions {
    storage?: "fs";
    path?: string;
    filename?: string;
    disableTimer?: boolean;
    log?: { debug(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
  }

  interface FakeGatoHistoryService extends Service {
    addEntry(entry: Record<string, number>): void;
  }

  type FakeGatoHistoryConstructor = new (type: string, accessory: PlatformAccessory, options?: FakeGatoOptions) => FakeGatoHistoryService;

  export default function fakegato(api: API): FakeGatoHistoryConstructor;
}
