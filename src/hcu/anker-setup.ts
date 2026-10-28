import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ANKER_ADAPTER_ID, AnkerCloudAdapter } from "../adapters/anker/anker-adapter.js";
import { AnkerCloudClient, type AnkerCredentials } from "../adapters/anker/anker-cloud-client.js";
import { AdapterPoller } from "../adapters/poller.js";
import type { AdapterRegistry } from "../adapters/adapter-registry.js";
import type { DeviceAdapter } from "../adapters/device-adapter.js";
import type { EventBus } from "../events/event-bus.js";
import type { DeviceRegistry } from "../registry/device-registry.js";
import type { PluginMessage } from "./connect-api.js";

export interface AnkerSetupOptions {
  pluginId: string;
  dataFile: string;
  devices: DeviceRegistry;
  adapters: AdapterRegistry;
  bus: EventBus;
  pollIntervalMs?: number;
  createAdapter?: (credentials: AnkerCredentials) => DeviceAdapter;
  log?: (line: string) => void;
}

/** Configuration via HCUweb (CONFIG_TEMPLATE/UPDATE) and activation of the Anker adapter. */
export class AnkerSetup {
  private credentials: AnkerCredentials | undefined;
  private poller: AdapterPoller | undefined;

  constructor(private readonly options: AnkerSetupOptions) {}

  get configured(): boolean {
    return this.credentials !== undefined;
  }

  async load(): Promise<void> {
    let stored: Partial<AnkerCredentials>;
    try {
      stored = JSON.parse(await readFile(this.options.dataFile, "utf8")) as Partial<AnkerCredentials>;
    } catch {
      return;
    }
    if (stored.email && stored.password && stored.country) {
      const credentials = { email: stored.email, password: stored.password, country: stored.country };
      try {
        await this.activate(credentials);
      } catch (error) {
        this.options.log?.(`Anker activation failed: ${describe(error)}`);
      }
    }
  }

  async handle(message: PluginMessage): Promise<PluginMessage | undefined> {
    switch (message.type) {
      case "PLUGIN_STATE_REQUEST":
        return this.reply(message, "PLUGIN_STATE_RESPONSE", {
          pluginReadinessStatus: this.configured ? "READY" : "CONFIG_REQUIRED",
        });
      case "CONFIG_TEMPLATE_REQUEST":
        return this.reply(message, "CONFIG_TEMPLATE_RESPONSE", this.template());
      case "CONFIG_UPDATE_REQUEST":
        return this.update(message);
      default:
        return undefined;
    }
  }

  stop(): void {
    this.poller?.stop();
  }

  private template() {
    return {
      groups: {
        anker: {
          friendlyName: "Anker Solix",
          description: "Zugangsdaten der Anker-App (inoffizielle Cloud-Schnittstelle, nur lesend).",
          order: 1,
        },
      },
      properties: {
        email: { dataType: "STRING", friendlyName: "E-Mail", groupId: "anker", required: true, order: 1, ...(this.credentials && { currentValue: this.credentials.email }) },
        password: { dataType: "PASSWORD", friendlyName: "Passwort", groupId: "anker", required: !this.credentials, order: 2 },
        country: { dataType: "STRING", friendlyName: "Land (2 Buchstaben)", groupId: "anker", required: true, pattern: "^[A-Za-z]{2}$", defaultValue: "DE", order: 3, ...(this.credentials && { currentValue: this.credentials.country }) },
      },
    };
  }

  private async update(message: PluginMessage): Promise<PluginMessage> {
    const properties = ((message.body as { properties?: Record<string, unknown> })?.properties ?? {});
    const email = text(properties.email) ?? this.credentials?.email;
    const password = text(properties.password) ?? this.credentials?.password;
    const country = text(properties.country) ?? this.credentials?.country;
    if (!email || !password || !country || !/^[A-Za-z]{2}$/.test(country)) {
      return this.reply(message, "CONFIG_UPDATE_RESPONSE", {
        status: "FAILED",
        message: "E-Mail, Passwort und ein zweistelliges Land sind erforderlich.",
      });
    }

    const credentials = { email, password, country: country.toUpperCase() };
    try {
      await this.activate(credentials);
      await mkdir(dirname(this.options.dataFile), { recursive: true });
      await writeFile(this.options.dataFile, JSON.stringify(credentials), { mode: 0o600 });
      await chmod(this.options.dataFile, 0o600);
      return this.reply(message, "CONFIG_UPDATE_RESPONSE", { status: "APPLIED" });
    } catch (error) {
      this.options.log?.(`Anker configuration failed: ${describe(error)}`);
      return this.reply(message, "CONFIG_UPDATE_RESPONSE", {
        status: "FAILED",
        message: `Anker-Anmeldung fehlgeschlagen: ${describe(error)}`,
      });
    }
  }

  private async activate(credentials: AnkerCredentials): Promise<void> {
    const adapter =
      this.options.createAdapter?.(credentials) ?? new AnkerCloudAdapter(new AnkerCloudClient(credentials));
    const definitions = await adapter.discover();

    this.poller?.stop();
    if (!this.options.adapters.get(ANKER_ADAPTER_ID)) {
      this.options.adapters.register(adapter);
    }
    for (const definition of definitions) {
      if (!this.options.devices.get(definition.id)) {
        this.options.devices.register(definition);
      }
    }
    this.credentials = credentials;
    this.options.log?.(`Anker: ${definitions.length} Solarbank(s) gefunden.`);

    this.poller = new AdapterPoller({
      adapter,
      devices: this.options.devices,
      bus: this.options.bus,
      intervalMs: this.options.pollIntervalMs ?? 60_000,
      ...(this.options.log && { log: this.options.log }),
    });
    this.poller.start();
  }

  private reply(message: PluginMessage, type: string, body: unknown): PluginMessage {
    return { id: message.id, pluginId: this.options.pluginId, type, body };
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
