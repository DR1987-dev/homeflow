import { describe, expect, it, vi } from "vitest";
import {
  ActionDispatcher,
  type ActionSafetyPolicy,
} from "../src/actions/action-dispatcher.js";
import { AdapterRegistry } from "../src/adapters/adapter-registry.js";
import type { DeviceAdapter } from "../src/adapters/device-adapter.js";
import type { DeviceDefinition } from "../src/domain/device.js";
import { DeviceRegistry } from "../src/registry/device-registry.js";

const device: DeviceDefinition = {
  id: "room-thermostat",
  adapterId: "homematic",
  manufacturer: "Homematic IP",
  model: "Thermostat",
  name: "Living room",
  capabilities: [
    { id: "temperature", label: "Target temperature", type: "number", readable: true, writable: true, unit: "°C", min: 5, max: 30 },
    { id: "mode", label: "Mode", type: "enum", readable: true, writable: true, values: ["auto", "manual"] },
    { id: "battery", label: "Battery", type: "number", readable: true, writable: false, unit: "%" },
  ],
};

function setup(policy: ActionSafetyPolicy) {
  const devices = new DeviceRegistry();
  devices.register(device);
  const adapters = new AdapterRegistry();
  const adapter: DeviceAdapter = {
    id: device.adapterId,
    discover: vi.fn().mockResolvedValue([device]),
    readState: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue(undefined),
  };
  adapters.register(adapter);
  return {
    adapter,
    dispatcher: new ActionDispatcher(devices, adapters, policy),
  };
}

describe("ActionDispatcher", () => {
  it("checks bounds and enum values before calling the adapter", async () => {
    const policy = { authorize: vi.fn<ActionSafetyPolicy["authorize"]>(() => undefined) };
    const { adapter, dispatcher } = setup(policy);

    await expect(dispatcher.dispatch({
      deviceId: device.id,
      capabilityId: "temperature",
      value: 31,
    })).rejects.toThrow("invalid");
    await expect(dispatcher.dispatch({
      deviceId: device.id,
      capabilityId: "mode",
      value: "holiday",
    })).rejects.toThrow("invalid");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(policy.authorize).not.toHaveBeenCalled();
  });

  it("does not allow writes to read-only capabilities", async () => {
    const { adapter, dispatcher } = setup({
      authorize: vi.fn<ActionSafetyPolicy["authorize"]>(() => undefined),
    });

    await expect(dispatcher.dispatch({
      deviceId: device.id,
      capabilityId: "battery",
      value: 20,
    })).rejects.toThrow("does not support write");
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("authorizes a valid action before delegating it to its adapter", async () => {
    const policy = { authorize: vi.fn<ActionSafetyPolicy["authorize"]>(() => undefined) };
    const { adapter, dispatcher } = setup(policy);
    const command = {
      deviceId: device.id,
      capabilityId: "temperature",
      value: 21,
    } as const;

    await dispatcher.dispatch(command);

    expect(policy.authorize).toHaveBeenCalledOnce();
    expect(adapter.execute).toHaveBeenCalledWith(command);
  });

  it("does not execute an action rejected by the safety policy", async () => {
    const policy = {
      authorize: vi.fn<ActionSafetyPolicy["authorize"]>(async () => {
        throw new Error("permission denied");
      }),
    };
    const { adapter, dispatcher } = setup(policy);

    await expect(dispatcher.dispatch({
      deviceId: device.id,
      capabilityId: "temperature",
      value: 21,
    })).rejects.toThrow("permission denied");
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
