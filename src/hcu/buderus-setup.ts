import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EmsEspAdapter } from "../adapters/buderus/ems-esp-adapter.js";
import { EmsEspClient, normalizeGatewayUrl } from "../adapters/buderus/ems-esp-client.js";
import { AdapterPoller } from "../adapters/poller.js";
import type { AdapterRegistry } from "../adapters/adapter-registry.js";
import type { EventBus } from "../events/event-bus.js";
import type { DeviceRegistry } from "../registry/device-registry.js";

const URL_KEY = "buderusGatewayUrl";
const TOKEN_KEY = "buderusAccessToken";
const SETPOINT_CONTROL_KEY = "buderusControlSetpointHc2";

export interface BuderusStoredConfig {
  gatewayUrl: string;
  accessToken?: string;
  controlSetpointHc2: boolean;
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
      await this.activate({
        gatewayUrl: normalizeGatewayUrl(stored.gatewayUrl),
        ...(stored.accessToken && { accessToken: stored.accessToken }),
        controlSetpointHc2: stored.controlSetpointHc2 === true,
      });
    } catch (error) {
      if (!isMissingFile(error)) {
        this.options.log?.(`Buderus activation failed: ${describe(error)}`);
      }
    }
  }

  stop(): void {
    this.poller?.stop();
  }

  allowedControlPairs(): readonly { deviceId: string; capabilityId: string }[] {
    return this.config?.controlSetpointHc2
      ? [{ deviceId: "emsesp:thermostat", capabilityId: "target_temperature_c" }]
      : [];
  }

  template() {
    return {
      groups: {
        buderus: {
          friendlyName: "Buderus / EMS-ESP",
          description: "Lokale EMS-ESP-REST-API des BBQKees-Gateways. Schreibzugriff nur für die RC35-Solltemperatur in Heizkreis 2 und nur nach Aktivierung.",
          order: 4,
        },
      },
      properties: {
        [URL_KEY]: {
          dataType: "STRING",
          friendlyName: "Gateway-Adresse (z. B. 192.168.178.99 oder http://192.168.178.99)",
          groupId: "buderus",
          required: false,
          order: 1,
          ...(this.config && { currentValue: this.config.gatewayUrl }),
        },
        [TOKEN_KEY]: {
          dataType: "PASSWORD",
          friendlyName: "EMS-ESP API-Token (für Schreibzugriff erforderlich)",
          groupId: "buderus",
          required: this.config?.controlSetpointHc2 ?? false,
          order: 2,
        },
        [SETPOINT_CONTROL_KEY]: {
          dataType: "BOOLEAN",
          friendlyName: "RC35-Solltemperatur in Heizkreis 2 über die HCU-App steuerbar machen (5–25 °C)",
          groupId: "buderus",
          order: 3,
          currentValue: String(this.config?.controlSetpointHc2 ?? false),
        },
      },
    };
  }

  async update(properties: Record<string, unknown>): Promise<UpdateResult> {
    const hasUrl = Object.hasOwn(properties, URL_KEY);
    const hasToken = Object.hasOwn(properties, TOKEN_KEY);
    const hasControl = Object.hasOwn(properties, SETPOINT_CONTROL_KEY);
    if (!hasUrl && !hasToken && !hasControl) {
      return { status: "APPLIED" };
    }
    const enteredUrl = text(properties[URL_KEY]);
    const enteredToken = text(properties[TOKEN_KEY]);
    const enabled = hasControl ? booleanValue(properties[SETPOINT_CONTROL_KEY]) : undefined;
    if (hasControl && enabled === undefined) {
      return { status: "FAILED", message: "Die Heizkreis-2-Steuerung muss explizit aktiviert oder deaktiviert werden." };
    }
    if (!enteredUrl && !enteredToken && !hasControl) {
      return { status: "APPLIED" };
    }
    const enteredGatewayUrl = enteredUrl ?? this.config?.gatewayUrl;
    const accessToken = enteredToken ?? this.config?.accessToken;
    if (!enteredGatewayUrl) {
      return enabled
        ? { status: "FAILED", message: "Bitte zuerst die Adresse des EMS-ESP-Gateways eintragen." }
        : { status: "APPLIED" };
    }

    let gatewayUrl: string;
    try {
      gatewayUrl = normalizeGatewayUrl(enteredGatewayUrl);
    } catch (error) {
      return { status: "FAILED", message: describe(error) };
    }
    const config = {
      gatewayUrl,
      ...(accessToken && { accessToken }),
      controlSetpointHc2: enabled ?? this.config?.controlSetpointHc2 ?? false,
    };
    if (config.controlSetpointHc2 && !config.accessToken) {
      return {
        status: "FAILED",
        message: "Zum Steuern ist ein EMS-ESP API-Token erforderlich (Settings → Security → Manage Users).",
      };
    }
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
      new EmsEspAdapter(new EmsEspClient(config.gatewayUrl, config.accessToken), config.controlSetpointHc2);
    const definitions = await adapter.discover();

    this.poller?.stop();
    this.options.adapters.replace(adapter);
    for (const definition of definitions) {
      this.options.devices.unregister(definition.id);
      this.options.devices.register(definition);
    }
    this.config = config;
    this.options.log?.(
      `Buderus / EMS-ESP: ${definitions.length} Gerät(e) gefunden; RC35-Heizkreis-2-Steuerung ${config.controlSetpointHc2 ? "aktiv" : "inaktiv"}.`,
    );
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

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) {
    return value.trim().toLowerCase() === "true";
  }
  return undefined;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
