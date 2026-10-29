import type {
  CapabilityReading,
  DeviceCommand,
  DeviceDefinition,
} from "../../domain/device.js";
import type { DeviceAdapter } from "../device-adapter.js";
import {
  HomeConnectApiError,
  HomeConnectClient,
  type HomeConnectAppliance,
  type HomeConnectStatusFeature,
} from "./home-connect-client.js";

export const HOME_CONNECT_ADAPTER_ID = "bosch-home-connect";

export class HomeConnectDeviceOfflineError extends Error {
  constructor(deviceId: string) {
    super(`Home Connect appliance "${deviceId}" is offline.`);
    this.name = "HomeConnectDeviceOfflineError";
  }
}

export class HomeConnectActionsBlockedError extends Error {
  constructor() {
    super("Home Connect actions are blocked until per-appliance control safety is implemented.");
    this.name = "HomeConnectActionsBlockedError";
  }
}

export class HomeConnectAdapter implements DeviceAdapter {
  readonly id = HOME_CONNECT_ADAPTER_ID;
  private readonly applianceIds = new Set<string>();

  constructor(private readonly client: HomeConnectClient) {}

  async discover(): Promise<readonly DeviceDefinition[]> {
    const appliances = await this.client.listAppliances();
    this.applianceIds.clear();
    const definitions: DeviceDefinition[] = [];

    for (const appliance of appliances) {
      const deviceId = toDeviceId(appliance.haId);
      this.applianceIds.add(deviceId);
      const features = appliance.connected === false
        ? []
        : await this.readDiscoverableStatus(appliance.haId);
      definitions.push(toDeviceDefinition(appliance, features));
    }

    return definitions;
  }

  async readState(deviceId: string): Promise<readonly CapabilityReading[]> {
    const haId = fromDeviceId(deviceId);
    if (!this.applianceIds.has(deviceId)) {
      throw new HomeConnectApiError(`Home Connect appliance "${deviceId}" is not discovered.`, 404);
    }

    const appliance = await this.client.getAppliance(haId);
    const observedAt = new Date().toISOString();
    const readings: CapabilityReading[] = appliance.connected === undefined
      ? []
      : [{ capabilityId: "connected", value: appliance.connected, observedAt }];
    if (appliance.connected === false) {
      return readings;
    }

    const features = await this.readDiscoverableStatus(haId);
    readings.push(
      ...features.map((feature) => ({
        capabilityId: statusCapabilityId(feature.key),
        value: feature.value,
        observedAt,
      })),
    );
    return readings;
  }

  async execute(_command: DeviceCommand): Promise<void> {
    throw new HomeConnectActionsBlockedError();
  }

  private async readDiscoverableStatus(haId: string): Promise<readonly HomeConnectStatusFeature[]> {
    try {
      return await this.client.getStatus(haId);
    } catch (error) {
      // A missing `<Type>-Monitor` scope must not hide the appliance itself.
      if (error instanceof HomeConnectApiError && error.status === 403) {
        return [];
      }
      throw error;
    }
  }
}

function toDeviceDefinition(
  appliance: HomeConnectAppliance,
  features: readonly HomeConnectStatusFeature[],
): DeviceDefinition {
  return {
    id: toDeviceId(appliance.haId),
    adapterId: HOME_CONNECT_ADAPTER_ID,
    manufacturer: appliance.brand ?? "Home Connect",
    model: appliance.vib ?? appliance.type ?? "Unknown Home Connect appliance",
    name: appliance.name ?? appliance.haId,
    capabilities: [
      ...(appliance.connected === undefined
        ? []
        : [{
            id: "connected",
            label: "Connected",
            type: "boolean" as const,
            readable: true,
            writable: false,
            supportStatus: "SUPPORTED" as const,
          }]),
      ...features.map((feature) => ({
        id: statusCapabilityId(feature.key),
        label: feature.key,
        type: valueType(feature.value),
        readable: true as const,
        writable: false as const,
        supportStatus: "SUPPORTED" as const,
      })),
    ],
  };
}

function valueType(value: boolean | number | string): "boolean" | "number" | "string" {
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return "number";
  }
  return "string";
}

function statusCapabilityId(key: string): string {
  return `status:${key}`;
}

function toDeviceId(haId: string): string {
  return `home-connect:${haId}`;
}

function fromDeviceId(deviceId: string): string {
  return deviceId.slice("home-connect:".length);
}
