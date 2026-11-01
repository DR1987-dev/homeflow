import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EmsEspAdapter } from "../adapters/buderus/ems-esp-adapter.js";
import { EmsEspClient } from "../adapters/buderus/ems-esp-client.js";
import { AdapterPoller } from "../adapters/poller.js";
import type { AdapterRegistry } from "../adapters/adapter-registry.js";
import type { EventBus } from "../events/event-bus.js";
import type { DeviceRegistry } from "../registry/device-registry.js";

const URL_KEY = "buderusGatewayUrl";
const TOKEN_KEY = "buderusAccessToken";

export interface BuderusStoredConfig {
  gatewayUrl: string;
  accessToken?: string;
}

export interface BuderusSetupOptions {
  dataFile: string;
  devices: DeviceRegistry;
  adapters: AdapterRegistry;
  bus: EventBus;
  pollIntervalMs?: number;
  createAdapter?: (config: BuderusStoredConfig) => EmsEspAdapter;
  log?: (line: string) => void;
}

type UpdateResult = { status: "APPLIED" | "FAILED"; message?: string };

/** Read-only connection to the local EMS-ESP HTTP API via the BBQKees gateway. */
export class BuderusSetup {
  private config: BuderusStoredConfig | undefined;
  private poller: AdapterPoller | undefined;

  constructor(private readonly options: BuderusSetupOptions) {}

  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.options.dataFile, "utf8")) as Partial<BuderusStoredConfig>;
      if (!stored.gatewayUrl) {
        return;
      }
      await this.activate({ gatewayUrl: stored.gatewayUrl, ...(stored.accessToken && { accessToken: stored.accessToken }) });
    } catch (error) {
      if (!isMissingFile(error)) {
        this.options.log?.(`Buderus activation failed: ${describe(error)}`);
      }
    }
  }

  stop(): void {
    this.poller?.stop();
  }

  template() {
    return {
      groups: {
        buderus: {
          friendlyName: "Buderus / EMS-ESP",
          description: "Lokale EMS-ESP-REST-API des BBQKees-Gateways. HomeFlow liest Werte; Steuerung ist deaktiviert.",
          order: 4,
        },
      },
      properties: {
        [URL_KEY]: {
          dataType: "STRING",
          friendlyName: "Gateway-Adresse (z. B. http://192.168.178.50)",
          groupId: "buderus",
          required: false,
          order: 1,
          ...(this.config && { currentValue: this.config.gatewayUrl }),
        },
        [TOKEN_KEY]: {
          dataType: "PASSWORD",
          friendlyName: "EMS-ESP API-Token (optional, falls API-Zugriff geschützt ist)",
          groupId: "buderus",
          required: false,
          order: 2,
        },
      },
    };
  }

  async update(properties: Record<string, unknown>): Promise<UpdateResult> {
    if (!Object.hasOwn(properties, URL_KEY) && !Object.hasOwn(properties, TOKEN_KEY)) {
      return { status: "APPLIED" };
    }
    const enteredUrl = text(properties[URL_KEY]);
    const enteredToken = text(properties[TOKEN_KEY]);
    if (!enteredUrl && !enteredToken) {
      return { status: "APPLIED" };
    }
    const gatewayUrl = enteredUrl ?? this.config?.gatewayUrl;
    const accessToken = enteredToken ?? this.config?.accessToken;
    if (!gatewayUrl) {
      return { status: "FAILED", message: "Bitte die Adresse des EMS-ESP-Gateways eintragen." };
    }

    const config = { gatewayUrl, ...(accessToken && { accessToken }) };
    try {
      await this.activate(config);
      await mkdir(dirname(this.options.dataFile), { recursive: true });
      await writeFile(this.options.dataFile, JSON.stringify(config), { mode: 0o600 });
      await chmod(this.options.dataFile, 0o600);
      return { status: "APPLIED" };
    } catch (error) {
      const message = describe(error);
      this.options.log?.(`Buderus configuration failed: ${message}`);
      return { status: "FAILED", message: `EMS-ESP-Verbindung fehlgeschlagen: ${message}` };
    }
  }

  private async activate(config: BuderusStoredConfig): Promise<void> {
    const adapter =
      this.options.createAdapter?.(config) ??
      new EmsEspAdapter(new EmsEspClient(config.gatewayUrl, config.accessToken));
    const definitions = await adapter.discover();

    this.poller?.stop();
    this.options.adapters.replace(adapter);
    for (const definition of definitions) {
      if (!this.options.devices.get(definition.id)) {
        this.options.devices.register(definition);
      }
    }
    this.config = config;
    this.options.log?.(`Buderus / EMS-ESP: ${definitions.length} Gerät(e) gefunden (nur lesend).`);
    this.poller = new AdapterPoller({
      adapter,
      devices: this.options.devices,
      bus: this.options.bus,
      intervalMs: this.options.pollIntervalMs ?? 30_000,
      ...(this.options.log && { log: this.options.log }),
    });
    this.poller.start();
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
