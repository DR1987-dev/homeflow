import type {
  CapabilityReading,
  DeviceCommand,
  DeviceDefinition,
} from "../../domain/device.js";
import type { EventBus } from "../../events/event-bus.js";
import type { DeviceAdapter } from "../device-adapter.js";
import { HomeConnectApiError, type HomeConnectAppliance, type HomeConnectClient } from "./home-connect-client.js";

export const HOME_CONNECT_CONTROL_ADAPTER_ID = "bosch-home-connect-control";
export const CONTROL_DEVICE_PREFIX = "home-connect-ctl:";

const POWER_STATE = "BSH.Common.Setting.PowerState";
const POWER_ON = "BSH.Common.EnumType.PowerState.On";
const POWER_OFF_VALUES = [
  "BSH.Common.EnumType.PowerState.Standby",
  "BSH.Common.EnumType.PowerState.Off",
];
const LIGHTING = "Cooking.Common.Setting.Lighting";
const HOOD_VENTING_PROGRAM = "Cooking.Common.Program.Hood.Venting";
const HOOD_VENTING_LEVEL = "Cooking.Common.Option.Hood.VentingLevel";
const DURATION_OPTION = "BSH.Common.Option.Duration";
const REMOTE_START_ALLOWED = "BSH.Common.Status.RemoteControlStartAllowed";
const MAX_OVEN_DURATION_SECONDS = 3600;

export type ControlKind = "power" | "light" | "fan" | "program";

/**
 * Appliance types and the control switches HomeFlow offers for them. Hobs are absent on purpose: the Home Connect
 * documentation lists no program or setting that starts heating on a hob, so no hob control exists.
 */
const CONTROLS_BY_TYPE: Readonly<Record<string, readonly ControlKind[]>> = {
  Dishwasher: ["power", "program"],
  Washer: ["program"],
  Dryer: ["program"],
  CoffeeMaker: ["power", "program"],
  Hood: ["power", "light", "fan"],
  Oven: ["program"],
};

/** Scopes needed to operate the supported control switches; the Monitor scopes remain separate. */
export const HOME_CONNECT_CONTROL_SCOPES = Object.keys(CONTROLS_BY_TYPE).flatMap((type) => [
  `${type}-Control`,
  `${type}-Settings`,
]);

export interface ControlProgramConfig {
  programKey?: string;
  durationMinutes?: number;
  fanStage?: string;
}

export interface ControlSwitchSpec {
  deviceId: string;
  haId: string;
  applianceName: string;
  applianceType: string;
  kind: ControlKind;
}

export class HomeConnectControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeConnectControlError";
  }
}

const KIND_LABEL: Record<ControlKind, string> = {
  power: "Ein/Aus",
  light: "Licht",
  fan: "Lüfter",
  program: "Programm",
};

export function controlDeviceId(haId: string, kind: ControlKind): string {
  return `${CONTROL_DEVICE_PREFIX}${haId}:${kind}`;
}

export function controlSpecsFor(appliances: readonly HomeConnectAppliance[]): ControlSwitchSpec[] {
  return appliances.flatMap((appliance) =>
    (CONTROLS_BY_TYPE[appliance.type ?? ""] ?? []).map((kind) => ({
      deviceId: controlDeviceId(appliance.haId, kind),
      haId: appliance.haId,
      applianceName: appliance.name ?? appliance.haId,
      applianceType: appliance.type ?? "",
      kind,
    })),
  );
}

export function controlDefinition(spec: ControlSwitchSpec): DeviceDefinition {
  return {
    id: spec.deviceId,
    adapterId: HOME_CONNECT_CONTROL_ADAPTER_ID,
    manufacturer: "Bosch",
    model: `${spec.applianceType} ${KIND_LABEL[spec.kind]}`,
    name: `${spec.applianceName} ${KIND_LABEL[spec.kind]}`,
    kind: "switch",
    capabilities: [
      { id: "on", label: KIND_LABEL[spec.kind], type: "boolean", readable: true, writable: true, supportStatus: "SUPPORTED" },
    ],
  };
}

export interface HomeConnectControlOptions {
  client: HomeConnectClient;
  bus: EventBus;
  /** The specs whose switches are currently enabled; execution is refused for everything else. */
  enabled: () => readonly ControlSwitchSpec[];
  config: (haId: string) => ControlProgramConfig;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Operates Home Connect appliances through explicitly enabled switches, with state checks and read-back. */
export class HomeConnectControlAdapter implements DeviceAdapter {
  readonly id = HOME_CONNECT_CONTROL_ADAPTER_ID;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: HomeConnectControlOptions) {}

  async discover(): Promise<readonly DeviceDefinition[]> {
    return this.options.enabled().map(controlDefinition);
  }

  async readState(deviceId: string): Promise<readonly CapabilityReading[]> {
    const spec = this.spec(deviceId);
    return [{ capabilityId: "on", value: await this.read(spec), observedAt: this.timestamp() }];
  }

  async execute(command: DeviceCommand): Promise<void> {
    if (command.capabilityId !== "on" || typeof command.value !== "boolean") {
      throw new HomeConnectControlError(`Unsupported command for "${command.deviceId}".`);
    }
    const spec = this.spec(command.deviceId);
    const desired = command.value;

    await this.serialize(spec.haId, async () => {
      const current = await this.read(spec);
      if (current === desired) {
        return;
      }
      await this.apply(spec, desired);
      const confirmed = await this.read(spec);
      if (confirmed !== desired) {
        throw new HomeConnectControlError(
          `Home Connect did not confirm the change for "${spec.deviceId}".`,
        );
      }
      this.options.log?.(`Home Connect: ${spec.deviceId} -> ${desired ? "on" : "off"} confirmed.`);
    });

    await this.options.bus.publish({
      type: "device.state.changed",
      deviceId: spec.deviceId,
      capabilityId: "on",
      value: desired,
      observedAt: this.timestamp(),
    });
  }

  private spec(deviceId: string): ControlSwitchSpec {
    const spec = this.options.enabled().find((candidate) => candidate.deviceId === deviceId);
    if (!spec) {
      throw new HomeConnectControlError(`Control switch "${deviceId}" is not enabled.`);
    }
    return spec;
  }

  private async read(spec: ControlSwitchSpec): Promise<boolean> {
    const { client } = this.options;
    switch (spec.kind) {
      case "power":
        return (await client.getSetting(spec.haId, POWER_STATE)).value === POWER_ON;
      case "light":
        return (await client.getSetting(spec.haId, LIGHTING)).value === true;
      case "fan":
        return (await client.getActiveProgramKey(spec.haId)) === HOOD_VENTING_PROGRAM;
      case "program": {
        const key = this.options.config(spec.haId).programKey;
        return key !== undefined && (await client.getActiveProgramKey(spec.haId)) === key;
      }
    }
  }

  private async apply(spec: ControlSwitchSpec, on: boolean): Promise<void> {
    const { client } = this.options;
    switch (spec.kind) {
      case "power": {
        if (on) {
          return client.putSetting(spec.haId, POWER_STATE, POWER_ON);
        }
        const { allowedValues } = await client.getSetting(spec.haId, POWER_STATE);
        const target = POWER_OFF_VALUES.find((value) => allowedValues?.includes(value));
        if (!target) {
          throw new HomeConnectControlError("The appliance reports no writable off/standby power state.");
        }
        return client.putSetting(spec.haId, POWER_STATE, target);
      }
      case "light":
        return client.putSetting(spec.haId, LIGHTING, on);
      case "fan":
        return on
          ? this.startProgram(spec, HOOD_VENTING_PROGRAM, [
              { key: HOOD_VENTING_LEVEL, value: this.options.config(spec.haId).fanStage ?? "Cooking.Hood.EnumType.Stage.FanStage01" },
            ])
          : client.stopProgram(spec.haId);
      case "program": {
        const config = this.options.config(spec.haId);
        if (!config.programKey) {
          throw new HomeConnectControlError(`No program is configured for "${spec.deviceId}".`);
        }
        if (!on) {
          return client.stopProgram(spec.haId);
        }
        return this.startProgram(spec, config.programKey, this.programOptions(spec, config));
      }
    }
  }

  private programOptions(spec: ControlSwitchSpec, config: ControlProgramConfig) {
    if (spec.applianceType !== "Oven") {
      return [];
    }
    const minutes = config.durationMinutes;
    if (minutes === undefined || !(minutes > 0) || minutes * 60 > MAX_OVEN_DURATION_SECONDS) {
      throw new HomeConnectControlError(
        `Oven programs require a duration of 1-${MAX_OVEN_DURATION_SECONDS / 60} minutes.`,
      );
    }
    return [{ key: DURATION_OPTION, value: Math.round(minutes * 60) }];
  }

  /** Starts only programs that the appliance currently offers and only while remote start is allowed. */
  private async startProgram(
    spec: ControlSwitchSpec,
    key: string,
    programOptions: readonly { key: string; value: boolean | number | string }[],
  ): Promise<void> {
    const { client } = this.options;
    const status = await client.getStatus(spec.haId);
    if (status.find((feature) => feature.key === REMOTE_START_ALLOWED)?.value !== true) {
      throw new HomeConnectControlError(
        "Remote start is not allowed: enable Remote Start on the appliance first.",
      );
    }
    const available = await client.getAvailableProgramKeys(spec.haId);
    if (!available.includes(key)) {
      throw new HomeConnectControlError(`Program "${key}" is not available on this appliance.`);
    }
    try {
      await client.startProgram(spec.haId, key, programOptions);
    } catch (error) {
      if (error instanceof HomeConnectApiError && error.status === 409) {
        throw new HomeConnectControlError("The appliance refused the start in its current state.");
      }
      throw error;
    }
  }

  private async serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) {
        this.locks.delete(key);
      }
    }
  }

  private timestamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
