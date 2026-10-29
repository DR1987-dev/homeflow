import { randomUUID } from "node:crypto";
import type { DeviceAdapter } from "../adapters/device-adapter.js";
import type { AdapterRegistry } from "../adapters/adapter-registry.js";
import type { CapabilityReading, DeviceCommand, DeviceDefinition } from "../domain/device.js";
import type { EventBus } from "../events/event-bus.js";
import type { GeoLocation } from "../automation/engine.js";
import { ILLUMINANCE, SHUTTER_LEVEL } from "../automation/shutter-sunset.js";
import type { DeviceRegistry } from "../registry/device-registry.js";
import type { PluginMessage } from "./connect-api.js";

export const HCU_SYSTEM_ADAPTER_ID = "hcu-system";

type Json = Record<string, unknown>;

type Target =
  | { kind: "channel"; deviceId: string; channelIndex: number }
  | { kind: "group"; groupId: string };

export const hcuSystemDeviceId = (deviceId: string, channelIndex: number) =>
  `hcu:${deviceId}:${channelIndex}`;
export const hcuGroupDeviceId = (groupId: string) => `hcu-group:${groupId}`;

const shutterCapability = (label: string): DeviceDefinition["capabilities"][number] => ({
  id: SHUTTER_LEVEL,
  label,
  type: "number",
  readable: true,
  writable: true,
  min: 0,
  max: 1,
});

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Brightness of a weather sensor channel in lux. Field names are not verified against a real HmIP-SWO-PRO. */
export function illuminationOf(channel: Json): number | undefined {
  return (
    finite(channel.averageIllumination) ??
    finite(channel.illumination) ??
    finite(channel.currentIllumination)
  );
}

interface Extracted {
  definition: DeviceDefinition;
  ref: Target;
  readings: Record<string, number>;
}

function extract(device: Json): Extracted[] {
  const id = device.id;
  const channels = device.functionalChannels;
  if (typeof id !== "string" || !isRecord(channels)) {
    return [];
  }
  const label = typeof device.label === "string" && device.label ? device.label : id;
  const model = typeof device.modelType === "string" ? device.modelType : "unknown";

  const result: Extracted[] = [];
  for (const channel of Object.values(channels)) {
    if (!isRecord(channel)) continue;
    const index = finite(channel.index);
    if (index === undefined) continue;

    const lux = illuminationOf(channel);
    const level = finite(channel.shutterLevel);
    if (lux === undefined && level === undefined) continue;

    const readings: Record<string, number> = {};
    const capabilities: DeviceDefinition["capabilities"][number][] = [];
    if (lux !== undefined) {
      readings[ILLUMINANCE] = lux;
      capabilities.push({
        id: ILLUMINANCE,
        label: "Illuminance",
        type: "number",
        unit: "lx",
        readable: true,
        writable: false,
        min: 0,
      });
    }
    if (level !== undefined) {
      readings[SHUTTER_LEVEL] = level;
      capabilities.push(shutterCapability("Shutter level (0 open, 1 closed)"));
    }
    result.push({
      definition: {
        id: hcuSystemDeviceId(id, index),
        adapterId: HCU_SYSTEM_ADAPTER_ID,
        manufacturer: "eQ-3",
        model,
        name: label,
        capabilities,
      },
      ref: { kind: "channel", deviceId: id, channelIndex: index },
      readings,
    });
  }
  return result;
}

export interface HcuSystemOptions {
  pluginId: string;
  send: (message: PluginMessage) => void;
  bus: EventBus;
  devices: DeviceRegistry;
  adapters: AdapterRegistry;
  requestTimeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * Mirrors the HCU system state (weather sensors, shutters) into HomeFlow devices via the
 * Connect API, and executes shutter commands through HMIP_SYSTEM_REQUEST.
 */
export class HcuSystem implements DeviceAdapter {
  readonly id = HCU_SYSTEM_ADAPTER_ID;
  private readonly pending = new Map<
    string,
    { resolve: (body: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly refs = new Map<string, Target>();
  private readonly shutterChannels = new Set<string>();
  private readonly values = new Map<string, Map<string, number>>();
  private readonly unreachable = new Map<string, boolean>();
  private currentLocation: GeoLocation | undefined;

  constructor(private readonly options: HcuSystemOptions) {
    options.adapters.register(this);
  }

  get location(): GeoLocation | undefined {
    return this.currentLocation;
  }

  async discover(): Promise<readonly DeviceDefinition[]> {
    return [...this.refs.keys()].flatMap((id) => this.options.devices.get(id) ?? []);
  }

  async readState(deviceId: string): Promise<readonly CapabilityReading[]> {
    const observedAt = new Date().toISOString();
    return [...(this.values.get(deviceId) ?? [])].map(([capabilityId, value]) => ({
      capabilityId,
      value,
      observedAt,
    }));
  }

  async execute(command: DeviceCommand): Promise<void> {
    const ref = this.refs.get(command.deviceId);
    if (!ref || command.capabilityId !== SHUTTER_LEVEL || typeof command.value !== "number") {
      throw new Error(`Unsupported HCU command for "${command.deviceId}"`);
    }
    if (ref.kind === "group") {
      await this.request("/hmip/group/switching/setPrimaryShadingLevel", {
        groupId: ref.groupId,
        primaryShadingLevel: command.value,
      });
      return;
    }
    await this.request("/hmip/device/control/setShutterLevel", {
      deviceId: ref.deviceId,
      channelIndex: ref.channelIndex,
      shutterLevel: command.value,
    });
  }

  /** Loads the initial system state; call after every (re)connect. Later changes arrive as events. */
  async load(): Promise<void> {
    const response = await this.request("/hmip/home/getSystemState", {});
    const body = isRecord(response.body) ? response.body : {};
    if (isRecord(body.home)) {
      await this.applyHome(body.home);
    }
    if (isRecord(body.devices)) {
      for (const device of Object.values(body.devices)) {
        if (isRecord(device)) await this.applyDevice(device);
      }
    }
    if (isRecord(body.groups)) {
      for (const group of Object.values(body.groups)) {
        if (isRecord(group)) await this.applyGroup(group);
      }
    }
    this.options.log?.(
      `HCU system state loaded: ${[...this.refs.keys()]
        .map((id) => `${id} (${this.options.devices.get(id)?.name})`)
        .join(", ") || "no sensors or shutters found"}`,
    );
  }

  /** Resolves requests and applies system events; always returns undefined so other handlers may run. */
  async handle(message: PluginMessage): Promise<undefined> {
    if (message.type === "HMIP_SYSTEM_RESPONSE") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        const body = isRecord(message.body) ? message.body : {};
        const code = finite(body.code);
        if (code !== undefined && code >= 200 && code < 300) {
          pending.resolve(body);
        } else {
          pending.reject(new Error(`HCU rejected request: ${JSON.stringify(body)}`));
        }
      }
    } else if (message.type === "HMIP_SYSTEM_EVENT") {
      await this.applyEvent(message.body);
    }
    return undefined;
  }

  private request(path: string, body: Json): Promise<Json> {
    const id = randomUUID();
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`HCU request ${path} timed out`));
      }, this.options.requestTimeoutMs ?? 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.options.send({
        id,
        pluginId: this.options.pluginId,
        type: "HMIP_SYSTEM_REQUEST",
        body: { path, body },
      });
    });
  }

  private async applyEvent(body: unknown): Promise<void> {
    const transaction = isRecord(body) && isRecord(body.eventTransaction) ? body.eventTransaction : undefined;
    const events = transaction && isRecord(transaction.events) ? transaction.events : {};
    const ordered = Object.entries(events).sort(([a], [b]) => Number(a) - Number(b));
    for (const [, event] of ordered) {
      if (!isRecord(event)) continue;
      switch (event.pushEventType) {
        case "DEVICE_ADDED":
        case "DEVICE_CHANGED":
          if (isRecord(event.device)) await this.applyDevice(event.device);
          break;
        case "GROUP_ADDED":
        case "GROUP_CHANGED":
          if (isRecord(event.group)) await this.applyGroup(event.group);
          break;
        case "HOME_CHANGED":
          if (isRecord(event.home)) await this.applyHome(event.home);
          break;
      }
    }
  }

  private async applyHome(home: Json): Promise<void> {
    const location = isRecord(home.location) ? home.location : undefined;
    const latitude = Number(location?.latitude);
    const longitude = Number(location?.longitude);
    if (
      location &&
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      typeof home.timeZoneId === "string"
    ) {
      this.currentLocation = { latitude, longitude, timeZone: home.timeZoneId };
    }
  }

  /**
   * Shading groups are SWITCHING groups whose members are all shutter channels. The type and field names
   * are taken from the Connect API documentation and not verified against a real HCU.
   */
  private async applyGroup(group: Json): Promise<void> {
    const id = group.id;
    const channels = Array.isArray(group.channels) ? group.channels.filter(isRecord) : [];
    if (typeof id !== "string" || group.type !== "SWITCHING" || channels.length === 0) {
      return;
    }
    const level = finite(group.primaryShadingLevel);
    const allShutters = channels.every((channel) =>
      this.shutterChannels.has(`${String(channel.deviceId)}:${String(channel.channelIndex)}`),
    );
    if (level === undefined && !allShutters) {
      return;
    }

    const deviceId = hcuGroupDeviceId(id);
    if (!this.options.devices.get(deviceId)) {
      this.options.devices.register({
        id: deviceId,
        adapterId: HCU_SYSTEM_ADAPTER_ID,
        manufacturer: "eQ-3",
        model: "Shading group",
        name: `Gruppe: ${typeof group.label === "string" && group.label ? group.label : id}`,
        capabilities: [shutterCapability("Primary shading level (0 open, 1 closed)")],
      });
      this.options.log?.(`HCU shading group found: ${deviceId} (${String(group.label)})`);
    }
    this.refs.set(deviceId, { kind: "group", groupId: id });

    if (level !== undefined) {
      const known = this.values.get(deviceId) ?? new Map<string, number>();
      this.values.set(deviceId, known);
      if (known.get(SHUTTER_LEVEL) !== level) {
        known.set(SHUTTER_LEVEL, level);
        await this.options.bus.publish({
          type: "device.state.changed",
          deviceId,
          capabilityId: SHUTTER_LEVEL,
          value: level,
          observedAt: new Date().toISOString(),
        });
      }
    }
  }

  private async applyDevice(device: Json): Promise<void> {
    const observedAt = new Date().toISOString();
    for (const { definition, ref, readings } of extract(device)) {
      if (!this.options.devices.get(definition.id)) {
        this.options.devices.register(definition);
        this.options.log?.(`HCU device found: ${definition.id} "${definition.name}" (${definition.model})`);
      }
      this.refs.set(definition.id, ref);
      if (ref.kind === "channel" && readings[SHUTTER_LEVEL] !== undefined) {
        this.shutterChannels.add(`${ref.deviceId}:${ref.channelIndex}`);
      }

      const known = this.values.get(definition.id) ?? new Map<string, number>();
      this.values.set(definition.id, known);
      for (const [capabilityId, value] of Object.entries(readings)) {
        if (known.get(capabilityId) === value) continue;
        known.set(capabilityId, value);
        await this.options.bus.publish({
          type: "device.state.changed",
          deviceId: definition.id,
          capabilityId,
          value,
          observedAt,
        });
      }

      const channel0 = isRecord(device.functionalChannels) ? device.functionalChannels["0"] : undefined;
      const unreach = isRecord(channel0) && typeof channel0.unreach === "boolean" ? channel0.unreach : undefined;
      if (unreach !== undefined && this.unreachable.get(definition.id) !== unreach) {
        this.unreachable.set(definition.id, unreach);
        await this.options.bus.publish({
          type: "device.availability.changed",
          deviceId: definition.id,
          available: !unreach,
          observedAt,
        });
      }
    }
  }
}
