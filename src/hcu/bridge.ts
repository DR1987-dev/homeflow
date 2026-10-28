import type { ActionDispatcher } from "../actions/action-dispatcher.js";
import type { EventBus } from "../events/event-bus.js";
import type { DeviceRegistry } from "../registry/device-registry.js";
import type { StateStore } from "../state/state-store.js";
import type { PluginMessage } from "./connect-api.js";
import {
  ControlMappingError,
  buildFeatureOf,
  featureTypeOf,
  toCommands,
  toHcuDevice,
  type HcuDevice,
  type HcuFeature,
} from "./device-mapper.js";
import { randomUUID } from "node:crypto";

export interface HcuBridgeOptions {
  pluginId: string;
  devices: DeviceRegistry;
  state: StateStore;
  dispatcher: ActionDispatcher;
  bus: EventBus;
  send: (message: PluginMessage) => void;
  log?: (line: string) => void;
}

/** Exposes HomeFlow devices to the HCU and routes HCU control requests through the action dispatcher. */
export class HcuBridge {
  private readonly included = new Set<string>();

  constructor(private readonly options: HcuBridgeOptions) {}

  start(): void {
    const { bus } = this.options;
    bus.subscribe("device.state.changed", (event) => {
      const device = this.options.devices.get(event.deviceId);
      const featureType = featureTypeOf(event.capabilityId);
      if (!device || !featureType || !this.included.has(device.id)) {
        return;
      }
      const feature = buildFeatureOf(featureType, device, this.options.state.get(device.id));
      if (feature) {
        this.sendStatusEvent(device.id, [feature]);
      }
    });
    bus.subscribe("device.availability.changed", (event) => {
      if (this.included.has(event.deviceId)) {
        this.sendStatusEvent(event.deviceId, [{ type: "maintenance", unreach: !event.available }]);
      }
    });
  }

  async handle(message: PluginMessage): Promise<PluginMessage | undefined> {
    const body = (message.body ?? {}) as Record<string, unknown>;
    switch (message.type) {
      case "DISCOVER_REQUEST": {
        const devices = this.mapDevices(this.options.devices.list().map((device) => device.id));
        this.options.log?.(`Discovery: offering ${devices.length} device(s) to the HCU.`);
        return this.reply(message, "DISCOVER_RESPONSE", { success: true, devices });
      }
      case "INCLUSION_EVENT":
        this.included.clear();
        for (const id of stringArray(body.deviceIds)) {
          this.included.add(id);
        }
        return this.statusResponse(message, [...this.included]);
      case "EXCLUSION_EVENT":
        for (const id of stringArray(body.deviceIds)) {
          this.included.delete(id);
        }
        return undefined;
      case "STATUS_REQUEST": {
        const requested = Array.isArray(body.deviceIds)
          ? stringArray(body.deviceIds)
          : [...this.included];
        return this.statusResponse(message, requested);
      }
      case "CONTROL_REQUEST":
        return this.control(message, body);
      default:
        return undefined;
    }
  }

  private mapDevices(ids: readonly string[]): HcuDevice[] {
    const mapped: HcuDevice[] = [];
    for (const id of ids) {
      const definition = this.options.devices.get(id);
      if (!definition) {
        continue;
      }
      const result = toHcuDevice(
        definition,
        this.options.state.get(id),
        this.options.state.isAvailable(id),
      );
      if (result.ok) {
        mapped.push(result.device);
      } else {
        this.options.log?.(`Device "${id}" not offered to HCU: ${result.reason}`);
      }
    }
    return mapped;
  }

  private statusResponse(message: PluginMessage, ids: readonly string[]): PluginMessage {
    return this.reply(message, "STATUS_RESPONSE", {
      success: true,
      devices: this.mapDevices(ids),
    });
  }

  private async control(
    message: PluginMessage,
    body: Record<string, unknown>,
  ): Promise<PluginMessage> {
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    const failure = (code: string, text: string) =>
      this.reply(message, "CONTROL_RESPONSE", {
        success: false,
        deviceId,
        error: { code, message: text },
      });

    const device = this.options.devices.get(deviceId);
    if (!device || !this.included.has(deviceId)) {
      return failure("UNKNOWN_DEVICE", `Device "${deviceId}" is not included.`);
    }

    try {
      const commands = toCommands(device, (body.features ?? []) as HcuFeature[]);
      for (const command of commands) {
        await this.options.dispatcher.dispatch(command);
      }
      return this.reply(message, "CONTROL_RESPONSE", { success: true, deviceId });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.options.log?.(`Control request for "${deviceId}" rejected: ${text}`);
      return failure(error instanceof ControlMappingError ? "UNSUPPORTED" : "REJECTED", text);
    }
  }

  private sendStatusEvent(deviceId: string, features: HcuFeature[]): void {
    this.options.send({
      id: randomUUID(),
      pluginId: this.options.pluginId,
      type: "STATUS_EVENT",
      body: { deviceId, features },
    });
  }

  private reply(message: PluginMessage, type: string, body: unknown): PluginMessage {
    return { id: message.id, pluginId: this.options.pluginId, type, body };
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
