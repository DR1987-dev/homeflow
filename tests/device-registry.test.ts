import { describe, expect, it } from "vitest";
import {
  DeviceRegistry,
  DuplicateDeviceError,
  InvalidDeviceDefinitionError,
} from "../src/registry/device-registry.js";
import type { DeviceDefinition } from "../src/domain/device.js";

const device: DeviceDefinition = {
  id: "solarbank-main",
  adapterId: "anker",
  manufacturer: "Anker",
  model: "SOLIX Solarbank",
  name: "Solarbank",
  capabilities: [{ id: "battery_level", label: "Battery level", type: "number", readable: true, writable: false, unit: "%" }],
};

describe("DeviceRegistry", () => {
  it("registers and retrieves device definitions", () => {
    const registry = new DeviceRegistry();
    registry.register(device);

    expect(registry.get(device.id)).toEqual(device);
    expect(registry.list()).toEqual([device]);
  });

  it("rejects duplicate device identifiers", () => {
    const registry = new DeviceRegistry();
    registry.register(device);

    expect(() => registry.register(device)).toThrow(DuplicateDeviceError);
  });

  it("rejects ambiguous capability identifiers", () => {
    const registry = new DeviceRegistry();
    const invalidDevice = {
      ...device,
      capabilities: [...device.capabilities, device.capabilities[0]!],
    };

    expect(() => registry.register(invalidDevice)).toThrow(InvalidDeviceDefinitionError);
  });
});
