import { describe, expect, it, vi } from "vitest";
import { ActionDispatcher, type ActionSafetyPolicy } from "../src/actions/action-dispatcher.js";
import { AdapterRegistry } from "../src/adapters/adapter-registry.js";
import type { DeviceAdapter } from "../src/adapters/device-adapter.js";
import type { DeviceDefinition } from "../src/domain/device.js";
import { InMemoryEventBus } from "../src/events/event-bus.js";
import { HcuBridge } from "../src/hcu/bridge.js";
import type { PluginMessage } from "../src/hcu/connect-api.js";
import { toCommands, toHcuDevice } from "../src/hcu/device-mapper.js";
import { DeviceRegistry } from "../src/registry/device-registry.js";
import { StateStore } from "../src/state/state-store.js";

const battery: DeviceDefinition = {
  id: "battery-1",
  adapterId: "test",
  manufacturer: "Test",
  model: "Battery",
  name: "Home battery",
  kind: "battery",
  capabilities: [
    { id: "battery_level", label: "Level", type: "number", readable: true, writable: false, min: 0, max: 100 },
    { id: "power_w", label: "Power", type: "number", readable: true, writable: false },
  ],
};

const heatPump: DeviceDefinition = {
  id: "hp-1",
  adapterId: "test",
  manufacturer: "Test",
  model: "Heat pump",
  name: "Heat pump",
  kind: "heat-pump",
  capabilities: [
    { id: "operation_mode", label: "Mode", type: "enum", readable: true, writable: true, values: ["auto", "heating"] },
  ],
};

const noFeatures: DeviceDefinition = { ...battery, id: "bad", capabilities: [] };

function setup(policy: ActionSafetyPolicy = { authorize: () => undefined }) {
  const bus = new InMemoryEventBus();
  const state = new StateStore(bus);
  const devices = new DeviceRegistry();
  [battery, heatPump, noFeatures].forEach((device) => devices.register(device));
  const adapter: DeviceAdapter = {
    id: "test",
    discover: async () => [],
    readState: async () => [],
    execute: vi.fn(async () => undefined),
  };
  const adapters = new AdapterRegistry();
  adapters.register(adapter);
  const sent: PluginMessage[] = [];
  const bridge = new HcuBridge({
    pluginId: "p",
    devices,
    state,
    dispatcher: new ActionDispatcher(devices, adapters, policy),
    bus,
    send: (message) => sent.push(message),
  });
  bridge.start();
  return { bus, bridge, adapter, sent };
}

const message = (type: string, body: unknown = {}): PluginMessage => ({ id: "m1", pluginId: "p", type, body });

describe("device mapper", () => {
  it("converts battery percent to a 0..1 fraction", () => {
    const result = toHcuDevice(battery, new Map([["battery_level", 40], ["power_w", -250]]), true);

    expect(result).toMatchObject({ ok: true, device: { deviceType: "BATTERY" } });
    expect(result.ok && result.device.features).toEqual([
      { type: "batteryState", batteryLevel: 0.4 },
      { type: "currentPower", currentPower: -250 },
      { type: "maintenance", unreach: false },
    ]);
  });

  it("does not offer a device lacking the archetype's required feature", () => {
    expect(toHcuDevice(noFeatures, new Map(), true)).toMatchObject({ ok: false });
    expect(toHcuDevice({ ...battery, kind: "heat-pump" }, new Map(), true)).toMatchObject({ ok: false });
  });

  it("rejects control of unsupported features and fields", () => {
    expect(() => toCommands(heatPump, [{ type: "dimming", dimLevel: 1 }])).toThrow("cannot be controlled");
    expect(() => toCommands(heatPump, [{ type: "switchState", on: true }])).toThrow("not supported");
  });

  it("maps HCU operation modes to HomeFlow enum values", () => {
    expect(toCommands(heatPump, [{ type: "climateOperationMode", climateOperationMode: "HEATING" }])).toEqual([
      { deviceId: "hp-1", capabilityId: "operation_mode", value: "heating" },
    ]);
  });
});

describe("HcuBridge", () => {
  it("offers only mappable devices on discovery", async () => {
    const { bridge } = setup();

    const reply = await bridge.handle(message("DISCOVER_REQUEST"));

    const devices = (reply?.body as { devices: { deviceId: string }[] }).devices;
    expect(reply?.type).toBe("DISCOVER_RESPONSE");
    expect(devices.map((device) => device.deviceId).sort()).toEqual(["battery-1", "hp-1"]);
  });

  it("answers an inclusion with the status of included devices and pushes only their changes", async () => {
    const { bridge, bus, sent } = setup();

    const reply = await bridge.handle(message("INCLUSION_EVENT", { deviceIds: ["battery-1"] }));
    expect(reply?.type).toBe("STATUS_RESPONSE");

    const at = "2026-10-28T12:00:00.000Z";
    await bus.publish({ type: "device.state.changed", deviceId: "battery-1", capabilityId: "battery_level", value: 80, observedAt: at });
    await bus.publish({ type: "device.state.changed", deviceId: "hp-1", capabilityId: "operation_mode", value: "auto", observedAt: at });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "STATUS_EVENT",
      body: { deviceId: "battery-1", features: [{ type: "batteryState", batteryLevel: 0.8 }] },
    });
  });

  it("stops reporting excluded devices", async () => {
    const { bridge, bus, sent } = setup();
    await bridge.handle(message("INCLUSION_EVENT", { deviceIds: ["battery-1"] }));
    await bridge.handle(message("EXCLUSION_EVENT", { deviceIds: ["battery-1"] }));

    await bus.publish({ type: "device.availability.changed", deviceId: "battery-1", available: false, observedAt: "t" });

    expect(sent).toHaveLength(0);
  });

  it("executes control requests through the dispatcher", async () => {
    const { bridge, adapter } = setup();
    await bridge.handle(message("INCLUSION_EVENT", { deviceIds: ["hp-1"] }));

    const reply = await bridge.handle(
      message("CONTROL_REQUEST", {
        deviceId: "hp-1",
        features: [{ type: "climateOperationMode", climateOperationMode: "HEATING" }],
      }),
    );

    expect(reply?.body).toEqual({ success: true, deviceId: "hp-1" });
    expect(adapter.execute).toHaveBeenCalledWith({ deviceId: "hp-1", capabilityId: "operation_mode", value: "heating" });
  });

  it("does not execute control that the safety policy rejects", async () => {
    const { bridge, adapter } = setup({
      authorize: () => {
        throw new Error("denied");
      },
    });
    await bridge.handle(message("INCLUSION_EVENT", { deviceIds: ["hp-1"] }));

    const reply = await bridge.handle(
      message("CONTROL_REQUEST", {
        deviceId: "hp-1",
        features: [{ type: "climateOperationMode", climateOperationMode: "AUTO" }],
      }),
    );

    expect(reply?.body).toMatchObject({ success: false, error: { code: "REJECTED" } });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("refuses control of devices that are not included", async () => {
    const { bridge, adapter } = setup();

    const reply = await bridge.handle(
      message("CONTROL_REQUEST", { deviceId: "hp-1", features: [{ type: "climateOperationMode", climateOperationMode: "AUTO" }] }),
    );

    expect(reply?.body).toMatchObject({ success: false, error: { code: "UNKNOWN_DEVICE" } });
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
