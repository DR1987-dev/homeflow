import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HOME_CONNECT_ADAPTER_ID, HomeConnectAdapter } from "../adapters/bosch/home-connect-adapter.js";
import { HomeConnectClient, type HomeConnectTokens } from "../adapters/bosch/home-connect-client.js";
import {
  HOME_CONNECT_SCOPES,
  pollDeviceToken,
  requestDeviceCode,
  type HomeConnectDeviceCode,
  type HomeConnectDeviceFlowOptions,
} from "../adapters/bosch/home-connect-device-flow.js";
import { AdapterPoller } from "../adapters/poller.js";
import type { AdapterRegistry } from "../adapters/adapter-registry.js";
import type { EventBus } from "../events/event-bus.js";
import type { DeviceRegistry } from "../registry/device-registry.js";
import type { PluginMessage } from "./connect-api.js";

interface StoredHomeConnect {
  clientId: string;
  clientSecret?: string;
  tokens?: HomeConnectTokens;
}

export interface HomeConnectSetupOptions {
  pluginId: string;
  dataFile: string;
  devices: DeviceRegistry;
  adapters: AdapterRegistry;
  bus: EventBus;
  /** Home Connect rate-limits API calls, so the default is deliberately slow. */
  pollIntervalMs?: number;
  flow?: HomeConnectDeviceFlowOptions;
  log?: (line: string) => void;
}

/** Read-only Home Connect setup: Client ID on the HCUweb page, approval via the OAuth Device Flow. */
export class HomeConnectSetup {
  private stored: StoredHomeConnect | undefined;
  private poller: AdapterPoller | undefined;
  private pending: HomeConnectDeviceCode | undefined;
  private lastError: string | undefined;
  private flowRun = 0;
  private activation: Promise<void> | undefined;

  constructor(private readonly options: HomeConnectSetupOptions) {}

  get connected(): boolean {
    return this.poller !== undefined;
  }

  async load(): Promise<void> {
    try {
      this.stored = JSON.parse(await readFile(this.options.dataFile, "utf8")) as StoredHomeConnect;
    } catch {
      return;
    }
    if (this.stored.clientId && this.stored.tokens?.accessToken) {
      try {
        await this.activate(this.stored.clientId, this.stored.tokens, this.stored.clientSecret);
      } catch (error) {
        this.lastError = describe(error);
        this.options.log?.(`Home Connect activation failed: ${this.lastError}`);
      }
    }
  }

  stop(): void {
    this.flowRun += 1;
    this.poller?.stop();
  }

  /** Resolves when a running authorization/activation finished (used by tests). */
  async idle(): Promise<void> {
    await this.activation;
  }

  template() {
    return {
      groups: {
        homeConnect: {
          friendlyName: "Bosch Home Connect",
          description: this.statusText(),
          order: 5,
        },
      },
      properties: {
        homeConnectClientId: {
          dataType: "STRING",
          friendlyName: "Home Connect Client ID (Device Flow)",
          groupId: "homeConnect",
          required: false,
          order: 1,
          ...(this.stored?.clientId && { currentValue: this.stored.clientId }),
        },
        homeConnectClientSecret: {
          dataType: "PASSWORD",
          friendlyName: "Home Connect Client Secret (optional)",
          groupId: "homeConnect",
          required: false,
          order: 2,
        },
      },
    };
  }

  async update(properties: Record<string, unknown>): Promise<{ status: "APPLIED" | "FAILED"; message?: string }> {
    const raw = properties.homeConnectClientId;
    const clientId = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
    const rawSecret = properties.homeConnectClientSecret;
    const typedSecret = typeof rawSecret === "string" && rawSecret.trim() !== "" ? rawSecret.trim() : undefined;
    if (!clientId) {
      return { status: "APPLIED" };
    }
    const clientSecret = typedSecret ?? (clientId === this.stored?.clientId ? this.stored.clientSecret : undefined);
    if (clientId === this.stored?.clientId && !typedSecret && (this.connected || this.pending)) {
      return { status: "APPLIED" };
    }

    this.stored = { clientId, ...(clientSecret ? { clientSecret } : {}) };
    try {
      await this.save();
    } catch (error) {
      return { status: "FAILED", message: `Home Connect konnte nicht gespeichert werden: ${describe(error)}` };
    }
    this.poller?.stop();
    this.poller = undefined;
    this.activation = this.authorize(clientId, clientSecret);
    return { status: "APPLIED" };
  }

  private async authorize(clientId: string, clientSecret?: string): Promise<void> {
    const run = ++this.flowRun;
    this.lastError = undefined;
    try {
      let code: HomeConnectDeviceCode;
      try {
        code = await requestDeviceCode(clientId, HOME_CONNECT_SCOPES, this.options.flow);
      } catch (error) {
        if (!describe(error).includes("invalid_scope")) {
          throw error;
        }
        code = await requestDeviceCode(clientId, ["IdentifyAppliance"], this.options.flow);
      }
      this.pending = code;
      this.options.log?.(
        `Home Connect: bitte ${code.verificationUriComplete ?? code.verificationUri} öffnen, Code ${code.userCode}.`,
      );
      const tokens = await pollDeviceToken(clientId, code, this.options.flow, clientSecret);
      if (run !== this.flowRun) {
        return;
      }
      this.pending = undefined;
      this.stored = { clientId, ...(clientSecret ? { clientSecret } : {}), tokens };
      await this.save();
      await this.activate(clientId, tokens, clientSecret);
    } catch (error) {
      if (run === this.flowRun) {
        this.pending = undefined;
        this.lastError = describe(error);
        this.options.log?.(`Home Connect authorization failed: ${this.lastError}`);
      }
    }
  }

  private async activate(clientId: string, tokens: HomeConnectTokens, clientSecret?: string): Promise<void> {
    const client = new HomeConnectClient({
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      tokens,
      onTokens: async (next) => {
        this.stored = { clientId, ...(clientSecret ? { clientSecret } : {}), tokens: next };
        await this.save();
      },
    });
    const adapter = new HomeConnectAdapter(client);
    const definitions = await adapter.discover();

    this.poller?.stop();
    if (!this.options.adapters.get(HOME_CONNECT_ADAPTER_ID)) {
      this.options.adapters.register(adapter);
    }
    for (const definition of definitions) {
      if (!this.options.devices.get(definition.id)) {
        this.options.devices.register(definition);
      }
    }
    this.options.log?.(`Home Connect: ${definitions.length} Gerät(e) gefunden (nur lesend).`);

    this.poller = new AdapterPoller({
      adapter: this.options.adapters.get(HOME_CONNECT_ADAPTER_ID) ?? adapter,
      devices: this.options.devices,
      bus: this.options.bus,
      intervalMs: this.options.pollIntervalMs ?? 600_000,
      ...(this.options.log && { log: this.options.log }),
    });
    this.poller.start();
  }

  private statusText(): string {
    if (this.pending) {
      return `Freigabe ausstehend: ${this.pending.verificationUriComplete ?? this.pending.verificationUri} öffnen und Code ${this.pending.userCode} eingeben.`;
    }
    if (this.connected) {
      return "Verbunden (nur lesend; Steuerung ist gesperrt).";
    }
    if (this.lastError) {
      return `Fehler: ${this.lastError}`;
    }
    return "Client ID eintragen und speichern, danach diese Seite erneut öffnen und den Freigabe-Code verwenden.";
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.options.dataFile), { recursive: true });
    await writeFile(this.options.dataFile, JSON.stringify(this.stored), { mode: 0o600 });
    await chmod(this.options.dataFile, 0o600);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
