import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HomeConnectAdapter } from "../adapters/bosch/home-connect-adapter.js";
import {
  CONTROL_DEVICE_PREFIX,
  HOME_CONNECT_CONTROL_SCOPES,
  HomeConnectControlAdapter,
  controlDefinition,
  controlSpecsFor,
  type ControlProgramConfig,
  type ControlSwitchSpec,
} from "../adapters/bosch/home-connect-control.js";
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

const SWITCH_PREFIX = "hcctl:";
const PROGRAM_PREFIX = "hcprog:";
const DURATION_PREFIX = "hcdur:";
const FAN_PREFIX = "hcfan:";
const FAN_STAGE_KEY = "Cooking.Hood.EnumType.Stage.FanStage0";

interface StoredControl {
  /** The user asked for control; switches stay off until each one is enabled individually. */
  requested: boolean;
  /** The current tokens were issued for the Control/Settings scopes. */
  granted: boolean;
  enabled: string[];
  programs: Record<string, ControlProgramConfig>;
}

interface StoredHomeConnect {
  clientId: string;
  clientSecret?: string;
  tokens?: HomeConnectTokens;
  control?: StoredControl;
}

export interface HomeConnectSetupOptions {
  pluginId: string;
  dataFile: string;
  devices: DeviceRegistry;
  adapters: AdapterRegistry;
  bus: EventBus;
  /** Home Connect allows 1000 requests per day, so the default polling interval is deliberately slow. */
  pollIntervalMs?: number;
  flow?: HomeConnectDeviceFlowOptions;
  log?: (line: string) => void;
}

type UpdateResult = { status: "APPLIED" | "FAILED"; message?: string };

/** Home Connect setup: Client ID on the HCUweb page, OAuth Device Flow approval, opt-in control switches. */
export class HomeConnectSetup {
  private stored: StoredHomeConnect | undefined;
  private statusPoller: AdapterPoller | undefined;
  private controlPoller: AdapterPoller | undefined;
  private pending: HomeConnectDeviceCode | undefined;
  private lastError: string | undefined;
  private flowRun = 0;
  private activation: Promise<void> | undefined;
  private specs: ControlSwitchSpec[] = [];
  private enabledSpecs: ControlSwitchSpec[] = [];
  private client: HomeConnectClient | undefined;
  private controlSignature = "";

  constructor(private readonly options: HomeConnectSetupOptions) {}

  get connected(): boolean {
    return this.client !== undefined;
  }

  /** The control switches currently allowed to receive commands (all others are rejected). */
  allowedControlPairs(): readonly { deviceId: string; capabilityId: string }[] {
    return this.enabledSpecs.map((spec) => ({ deviceId: spec.deviceId, capabilityId: "on" }));
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
    this.statusPoller?.stop();
    this.controlPoller?.stop();
  }

  /** Resolves when a running authorization/activation finished (used by tests). */
  async idle(): Promise<void> {
    await this.activation;
  }

  template() {
    const properties: Record<string, unknown> = {
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
      homeConnectControl: {
        dataType: "BOOLEAN",
        friendlyName: "Steuerung erlauben (erfordert neue Freigabe)",
        groupId: "homeConnect",
        order: 3,
        currentValue: String(this.stored?.control?.requested ?? false),
      },
    };
    const groups: Record<string, unknown> = {
      homeConnect: { friendlyName: "Bosch Home Connect", description: this.statusText(), order: 5 },
    };

    if (this.controlActive()) {
      groups.homeConnectControl = {
        friendlyName: "Home Connect Steuerung",
        description:
          "Jeder Schalter ist standardmäßig aus. Nur angehakte Schalter erscheinen in der HCU-App und dürfen Befehle senden. Programme starten nur, wenn am Gerät 'Fernstart' aktiv ist.",
        order: 6,
      };
      let order = 10;
      for (const spec of this.specs) {
        const config = this.stored?.control?.programs[spec.haId] ?? {};
        properties[`${SWITCH_PREFIX}${spec.deviceId}`] = {
          dataType: "BOOLEAN",
          friendlyName: controlDefinition(spec).name,
          groupId: "homeConnectControl",
          order: order++,
          currentValue: String(this.stored?.control?.enabled.includes(spec.deviceId) ?? false),
        };
        if (spec.kind === "program") {
          properties[`${PROGRAM_PREFIX}${spec.haId}`] = {
            dataType: "STRING",
            friendlyName: `${spec.applianceName}: Programm-Schlüssel (z. B. Dishcare.Dishwasher.Program.Eco50)`,
            groupId: "homeConnectControl",
            order: order++,
            ...(config.programKey && { currentValue: config.programKey }),
          };
        }
        if (spec.kind === "program" && spec.applianceType === "Oven") {
          properties[`${DURATION_PREFIX}${spec.haId}`] = {
            dataType: "STRING",
            friendlyName: `${spec.applianceName}: Dauer in Minuten (Pflicht, max. 60)`,
            groupId: "homeConnectControl",
            order: order++,
            ...(config.durationMinutes !== undefined && { currentValue: String(config.durationMinutes) }),
          };
        }
        if (spec.kind === "fan") {
          properties[`${FAN_PREFIX}${spec.haId}`] = {
            dataType: "STRING",
            friendlyName: `${spec.applianceName}: Lüfterstufe beim Einschalten (1-5)`,
            groupId: "homeConnectControl",
            order: order++,
            pattern: "^[1-5]$",
            currentValue: (config.fanStage ?? `${FAN_STAGE_KEY}1`).slice(-1),
          };
        }
      }
    }
    return { groups, properties };
  }

  async update(properties: Record<string, unknown>): Promise<UpdateResult> {
    if (!Object.keys(properties).some((key) => /^(homeConnect|hc(ctl|prog|dur|fan):)/.test(key))) {
      return { status: "APPLIED" };
    }
    const clientId = text(properties.homeConnectClientId);
    const typedSecret = text(properties.homeConnectClientSecret);
    const wantsControl =
      typeof properties.homeConnectControl === "boolean" ? properties.homeConnectControl : undefined;

    const previous = this.stored;
    const sameClient = clientId !== undefined && clientId === previous?.clientId;
    const control: StoredControl = {
      requested: false,
      granted: false,
      enabled: [],
      programs: {},
      ...(sameClient || clientId === undefined ? previous?.control : {}),
    };
    if (wantsControl !== undefined) {
      control.requested = wantsControl;
    }
    if (!control.requested) {
      control.enabled = [];
    }

    if (control.requested && control.granted) {
      const failure = this.applyControlSettings(control, properties);
      if (failure) {
        return { status: "FAILED", message: failure };
      }
    }

    if (!clientId) {
      if (!previous) {
        return { status: "APPLIED" };
      }
      this.stored = { ...previous, control };
      return this.persistAndSync(control.requested && !control.granted && !this.pending);
    }

    const clientSecret = typedSecret ?? (sameClient ? previous?.clientSecret : undefined);
    const authorize =
      !sameClient || typedSecret !== undefined || (control.requested && !control.granted && !this.pending);
    this.stored = {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(sameClient && previous?.tokens ? { tokens: previous.tokens } : {}),
      control,
    };
    return this.persistAndSync(authorize);
  }

  private applyControlSettings(control: StoredControl, properties: Record<string, unknown>): string | undefined {
    const known = new Set(this.specs.map((spec) => spec.deviceId));
    const enabled = new Set(control.enabled);
    for (const [key, value] of Object.entries(properties)) {
      if (key.startsWith(SWITCH_PREFIX) && typeof value === "boolean") {
        const deviceId = key.slice(SWITCH_PREFIX.length);
        if (!known.has(deviceId)) continue;
        if (value) enabled.add(deviceId);
        else enabled.delete(deviceId);
      } else if (key.startsWith(PROGRAM_PREFIX) && typeof value === "string") {
        const haId = key.slice(PROGRAM_PREFIX.length);
        const programKey = value.trim();
        if (programKey && !/^[A-Za-z0-9.]+$/.test(programKey)) {
          return "Programm-Schlüssel enthält ungültige Zeichen.";
        }
        const config = { ...control.programs[haId] };
        if (programKey) config.programKey = programKey;
        else delete config.programKey;
        control.programs[haId] = config;
      } else if (key.startsWith(DURATION_PREFIX) && typeof value === "string") {
        const haId = key.slice(DURATION_PREFIX.length);
        const config = { ...control.programs[haId] };
        if (value.trim() === "") {
          delete config.durationMinutes;
        } else {
          const minutes = Number(value);
          if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) {
            return "Die Backofen-Dauer muss zwischen 1 und 60 Minuten liegen.";
          }
          config.durationMinutes = minutes;
        }
        control.programs[haId] = config;
      } else if (key.startsWith(FAN_PREFIX) && typeof value === "string" && value.trim() !== "") {
        if (!/^[1-5]$/.test(value.trim())) {
          return "Die Lüfterstufe muss 1 bis 5 sein.";
        }
        const haId = key.slice(FAN_PREFIX.length);
        control.programs[haId] = { ...control.programs[haId], fanStage: `${FAN_STAGE_KEY}${value.trim()}` };
      }
    }
    control.enabled = [...enabled];
    return undefined;
  }

  private async persistAndSync(authorize: boolean): Promise<UpdateResult> {
    try {
      await this.save();
    } catch (error) {
      return { status: "FAILED", message: `Home Connect konnte nicht gespeichert werden: ${describe(error)}` };
    }
    if (authorize && this.stored) {
      this.statusPoller?.stop();
      this.controlPoller?.stop();
      this.client = undefined;
      this.syncControl();
      this.activation = this.authorize(this.stored.clientId, this.stored.clientSecret);
    } else {
      this.syncControl();
    }
    return { status: "APPLIED" };
  }

  private controlActive(): boolean {
    return Boolean(this.stored?.control?.requested && this.stored.control.granted && this.client);
  }

  private async authorize(clientId: string, clientSecret?: string): Promise<void> {
    const run = ++this.flowRun;
    this.lastError = undefined;
    const withControl = this.stored?.control?.requested === true;
    const attempts: { scopes: string[]; control: boolean }[] = [
      ...(withControl ? [{ scopes: [...HOME_CONNECT_SCOPES, ...HOME_CONNECT_CONTROL_SCOPES], control: true }] : []),
      { scopes: [...HOME_CONNECT_SCOPES], control: false },
      { scopes: ["IdentifyAppliance"], control: false },
    ];
    try {
      let code: HomeConnectDeviceCode | undefined;
      let granted = false;
      for (const attempt of attempts) {
        try {
          code = await requestDeviceCode(clientId, attempt.scopes, this.options.flow);
          granted = attempt.control;
          break;
        } catch (error) {
          if (!describe(error).includes("invalid_scope")) {
            throw error;
          }
        }
      }
      if (!code) {
        throw new Error("Home Connect rejected every requested scope.");
      }
      if (withControl && !granted) {
        this.options.log?.("Home Connect: Control-Scopes wurden vom Portal abgelehnt; nur lesender Zugriff.");
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
      const control: StoredControl = {
        requested: withControl,
        enabled: [],
        programs: {},
        ...this.stored?.control,
        granted,
      };
      this.stored = { clientId, ...(clientSecret ? { clientSecret } : {}), tokens, control };
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
        if (this.stored) {
          this.stored = { ...this.stored, tokens: next };
          await this.save();
        }
      },
    });
    const adapter = new HomeConnectAdapter(client);
    const definitions = await adapter.discover();
    this.specs = controlSpecsFor(await client.listAppliances());

    this.statusPoller?.stop();
    this.options.adapters.replace(adapter);
    for (const definition of definitions) {
      if (!this.options.devices.get(definition.id)) {
        this.options.devices.register(definition);
      }
    }
    this.options.log?.(`Home Connect: ${definitions.length} Gerät(e) gefunden.`);
    this.client = client;

    this.statusPoller = this.poller(adapter);
    this.statusPoller.start();
    this.syncControl();
  }

  /** Registers exactly the enabled control switches and drops the rest; nothing is enabled by default. */
  private syncControl(): void {
    const client = this.client;
    const control = this.stored?.control;
    const enabledIds = new Set(client && control?.requested && control.granted ? control.enabled : []);
    this.enabledSpecs = this.specs.filter(
      (spec) =>
        enabledIds.has(spec.deviceId) && (spec.kind !== "program" || Boolean(control?.programs[spec.haId]?.programKey)),
    );

    for (const device of this.options.devices.list()) {
      if (
        device.id.startsWith(CONTROL_DEVICE_PREFIX) &&
        !this.enabledSpecs.some((spec) => spec.deviceId === device.id)
      ) {
        this.options.devices.unregister(device.id);
      }
    }
    const signature = JSON.stringify([
      this.enabledSpecs.map((spec) => spec.deviceId),
      this.enabledSpecs.map((spec) => control?.programs[spec.haId]),
      client !== undefined,
    ]);
    if (signature === this.controlSignature && (this.controlPoller || this.enabledSpecs.length === 0)) {
      return;
    }
    this.controlSignature = signature;
    this.controlPoller?.stop();
    this.controlPoller = undefined;
    if (!client || this.enabledSpecs.length === 0) {
      return;
    }

    const adapter = new HomeConnectControlAdapter({
      client,
      bus: this.options.bus,
      enabled: () => this.enabledSpecs,
      config: (haId) => this.stored?.control?.programs[haId] ?? {},
      ...(this.options.log && { log: this.options.log }),
    });
    this.options.adapters.replace(adapter);
    for (const spec of this.enabledSpecs) {
      if (!this.options.devices.get(spec.deviceId)) {
        this.options.devices.register(controlDefinition(spec));
      }
    }
    this.controlPoller = this.poller(adapter);
    this.controlPoller.start();
    this.options.log?.(`Home Connect: ${this.enabledSpecs.length} Steuer-Schalter aktiv.`);
  }

  private poller(adapter: HomeConnectAdapter | HomeConnectControlAdapter): AdapterPoller {
    return new AdapterPoller({
      adapter,
      devices: this.options.devices,
      bus: this.options.bus,
      intervalMs: this.options.pollIntervalMs ?? 1_800_000,
      ...(this.options.log && { log: this.options.log }),
    });
  }

  private statusText(): string {
    if (this.pending) {
      return `Freigabe ausstehend: ${this.pending.verificationUriComplete ?? this.pending.verificationUri} öffnen und Code ${this.pending.userCode} eingeben.`;
    }
    if (this.connected) {
      const control = this.stored?.control;
      if (control?.requested && !control.granted) {
        return "Verbunden (nur lesend): Steuerung wurde angefragt, aber das Portal hat die Control-Scopes nicht erteilt.";
      }
      return control?.requested ? "Verbunden; Steuerung erlaubt (nur angehakte Schalter)." : "Verbunden (nur lesend).";
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

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
