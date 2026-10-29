import type { DeviceAdapter } from "../adapters/device-adapter.js";
import type { AdapterRegistry } from "../adapters/adapter-registry.js";
import type {
  CapabilitySupportStatus,
  CapabilityValue,
  DeviceCapability,
  DeviceCommand,
  DeviceDefinition,
} from "../domain/device.js";
import type { DeviceRegistry } from "../registry/device-registry.js";

export interface ActionContext {
  command: DeviceCommand;
  device: DeviceDefinition;
  capability: DeviceCapability;
}

export interface ActionSafetyPolicy {
  authorize(context: ActionContext): void | Promise<void>;
}

export class UnknownDeviceError extends Error {
  constructor(deviceId: string) {
    super(`Device "${deviceId}" is not registered.`);
    this.name = "UnknownDeviceError";
  }
}

export class UnknownCapabilityError extends Error {
  constructor(deviceId: string, capabilityId: string) {
    super(`Capability "${capabilityId}" is not defined for device "${deviceId}".`);
    this.name = "UnknownCapabilityError";
  }
}

export class CapabilityNotWritableError extends Error {
  constructor(capabilityId: string) {
    super(`Capability "${capabilityId}" does not support write actions.`);
    this.name = "CapabilityNotWritableError";
  }
}

export class CapabilityUnavailableError extends Error {
  constructor(capabilityId: string, status: CapabilitySupportStatus) {
    super(`Capability "${capabilityId}" is not available for actions (status: ${status}).`);
    this.name = "CapabilityUnavailableError";
  }
}

export class InvalidCapabilityValueError extends Error {
  constructor(capabilityId: string, value: CapabilityValue) {
    super(`Value "${String(value)}" is invalid for capability "${capabilityId}".`);
    this.name = "InvalidCapabilityValueError";
  }
}

export class AdapterUnavailableError extends Error {
  constructor(adapterId: string) {
    super(`Adapter "${adapterId}" is not registered.`);
    this.name = "AdapterUnavailableError";
  }
}

export class ActionDispatcher {
  constructor(
    private readonly devices: DeviceRegistry,
    private readonly adapters: AdapterRegistry,
    private readonly safetyPolicy: ActionSafetyPolicy,
  ) {}

  async dispatch(command: DeviceCommand): Promise<void> {
    const device = this.devices.get(command.deviceId);
    if (!device) {
      throw new UnknownDeviceError(command.deviceId);
    }

    const capability = device.capabilities.find(
      (candidate) => candidate.id === command.capabilityId,
    );
    if (!capability) {
      throw new UnknownCapabilityError(command.deviceId, command.capabilityId);
    }
    if (capability.supportStatus && capability.supportStatus !== "SUPPORTED") {
      throw new CapabilityUnavailableError(command.capabilityId, capability.supportStatus);
    }
    if (!capability.writable) {
      throw new CapabilityNotWritableError(command.capabilityId);
    }
    if (!isValidValue(capability, command.value)) {
      throw new InvalidCapabilityValueError(command.capabilityId, command.value);
    }

    const adapter = this.adapters.get(device.adapterId);
    if (!adapter) {
      throw new AdapterUnavailableError(device.adapterId);
    }

    await this.safetyPolicy.authorize({ command, device, capability });
    await adapter.execute(command);
  }
}

function isValidValue(capability: DeviceCapability, value: CapabilityValue): boolean {
  switch (capability.type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (capability.min === undefined || value >= capability.min) &&
        (capability.max === undefined || value <= capability.max)
      );
    case "string":
      return typeof value === "string";
    case "enum":
      return typeof value === "string" && capability.values.includes(value);
  }
}
