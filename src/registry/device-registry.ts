import type { DeviceDefinition } from "../domain/device.js";

export class DuplicateDeviceError extends Error {
  constructor(deviceId: string) {
    super(`Device "${deviceId}" is already registered.`);
    this.name = "DuplicateDeviceError";
  }
}

export class InvalidDeviceDefinitionError extends Error {
  constructor(deviceId: string, reason: string) {
    super(`Device "${deviceId}" has an invalid definition: ${reason}`);
    this.name = "InvalidDeviceDefinitionError";
  }
}

export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceDefinition>();

  register(device: DeviceDefinition): void {
    if (this.devices.has(device.id)) {
      throw new DuplicateDeviceError(device.id);
    }

    const capabilityIds = new Set<string>();
    for (const capability of device.capabilities) {
      if (!capability.id.trim() || capabilityIds.has(capability.id)) {
        throw new InvalidDeviceDefinitionError(
          device.id,
          `capability identifier "${capability.id}" is empty or duplicated`,
        );
      }
      capabilityIds.add(capability.id);

      if (
        capability.type === "number" &&
        ((capability.min !== undefined && !Number.isFinite(capability.min)) ||
          (capability.max !== undefined && !Number.isFinite(capability.max)) ||
          (capability.min !== undefined &&
            capability.max !== undefined &&
            capability.min > capability.max))
      ) {
        throw new InvalidDeviceDefinitionError(
          device.id,
          `capability "${capability.id}" has invalid numeric bounds`,
        );
      }

      if (
        capability.type === "enum" &&
        (capability.values.length === 0 ||
          new Set(capability.values).size !== capability.values.length)
      ) {
        throw new InvalidDeviceDefinitionError(
          device.id,
          `capability "${capability.id}" has invalid enum values`,
        );
      }
    }

    this.devices.set(device.id, device);
  }

  get(deviceId: string): DeviceDefinition | undefined {
    return this.devices.get(deviceId);
  }

  list(): readonly DeviceDefinition[] {
    return [...this.devices.values()];
  }
}
