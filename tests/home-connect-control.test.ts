import { describe, expect, it, vi } from "vitest";
import {
  HOME_CONNECT_CONTROL_SCOPES,
  HomeConnectControlAdapter,
  HomeConnectControlError,
  controlDeviceId,
  controlSpecsFor,
  type ControlProgramConfig,
} from "../src/adapters/bosch/home-connect-control.js";
import type { HomeConnectClient } from "../src/adapters/bosch/home-connect-client.js";
import { InMemoryEventBus } from "../src/events/event-bus.js";

function setup(options: {
  type: string;
  kind: "power" | "light" | "fan" | "program";
  config?: ControlProgramConfig;
  remoteStart?: boolean;
  confirm?: boolean;
}) {
  const state = { power: "BSH.Common.EnumType.PowerState.Standby", light: false, active: undefined as string | undefined };
  const client = {
    getSetting: vi.fn(async (_haId: string, key: string) =>
      key.endsWith("PowerState")
        ? { value: state.power, allowedValues: ["BSH.Common.EnumType.PowerState.On", "BSH.Common.EnumType.PowerState.Standby"] }
        : { value: state.light },
    ),
    putSetting: vi.fn(async (_haId: string, key: string, value: boolean | number | string) => {
      if (options.confirm === false) return;
      if (key.endsWith("PowerState")) state.power = String(value);
      else state.light = value === true;
    }),
    getStatus: vi.fn(async () => [
      { key: "BSH.Common.Status.RemoteControlStartAllowed", value: options.remoteStart ?? true },
    ]),
    getAvailableProgramKeys: vi.fn(async () => ["Program.A", "Cooking.Common.Program.Hood.Venting"]),
    getActiveProgramKey: vi.fn(async () => state.active),
    startProgram: vi.fn(async (_haId: string, key: string) => {
      state.active = key;
    }),
    stopProgram: vi.fn(async () => {
      state.active = undefined;
    }),
  };
  const [spec] = controlSpecsFor([{ haId: "ha-1", name: "Gerät", type: options.type }]).filter(
    (candidate) => candidate.kind === options.kind,
  );
  if (!spec) throw new Error("no spec");
  const adapter = new HomeConnectControlAdapter({
    client: client as unknown as HomeConnectClient,
    bus: new InMemoryEventBus(),
    enabled: () => [spec],
    config: () => options.config ?? {},
  });
  return { adapter, client, state, deviceId: spec.deviceId };
}

describe("HomeConnectControlAdapter", () => {
  it("switches power on, then to standby using the allowed values, with read-back", async () => {
    const { adapter, client, state, deviceId } = setup({ type: "Dishwasher", kind: "power" });
    await adapter.execute({ deviceId, capabilityId: "on", value: true });
    expect(state.power).toBe("BSH.Common.EnumType.PowerState.On");
    await adapter.execute({ deviceId, capabilityId: "on", value: false });
    expect(state.power).toBe("BSH.Common.EnumType.PowerState.Standby");
    expect(client.putSetting).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the appliance already has the requested state", async () => {
    const { adapter, client, deviceId } = setup({ type: "Dishwasher", kind: "power" });
    await adapter.execute({ deviceId, capabilityId: "on", value: false });
    expect(client.putSetting).not.toHaveBeenCalled();
  });

  it("fails when Home Connect does not confirm the change", async () => {
    const { adapter, deviceId } = setup({ type: "Dishwasher", kind: "power", confirm: false });
    await expect(adapter.execute({ deviceId, capabilityId: "on", value: true })).rejects.toThrow(/did not confirm/);
  });

  it("refuses to start a program while remote start is not allowed", async () => {
    const { adapter, client, deviceId } = setup({
      type: "Dishwasher",
      kind: "program",
      config: { programKey: "Program.A" },
      remoteStart: false,
    });
    await expect(adapter.execute({ deviceId, capabilityId: "on", value: true })).rejects.toThrow(/Remote start/);
    expect(client.startProgram).not.toHaveBeenCalled();
  });

  it("starts and stops only the configured, available program", async () => {
    const { adapter, client, state, deviceId } = setup({
      type: "Dishwasher",
      kind: "program",
      config: { programKey: "Program.A" },
    });
    await adapter.execute({ deviceId, capabilityId: "on", value: true });
    expect(client.startProgram).toHaveBeenCalledWith("ha-1", "Program.A", []);
    await adapter.execute({ deviceId, capabilityId: "on", value: false });
    expect(state.active).toBeUndefined();
  });

  it("rejects a configured program that the appliance does not offer", async () => {
    const { adapter, client, deviceId } = setup({
      type: "Dishwasher",
      kind: "program",
      config: { programKey: "Program.Unknown" },
    });
    await expect(adapter.execute({ deviceId, capabilityId: "on", value: true })).rejects.toThrow(/not available/);
    expect(client.startProgram).not.toHaveBeenCalled();
  });

  it("requires a bounded duration for oven programs and sends it in seconds", async () => {
    const missing = setup({ type: "Oven", kind: "program", config: { programKey: "Program.A" } });
    await expect(
      missing.adapter.execute({ deviceId: missing.deviceId, capabilityId: "on", value: true }),
    ).rejects.toBeInstanceOf(HomeConnectControlError);
    expect(missing.client.startProgram).not.toHaveBeenCalled();

    const valid = setup({ type: "Oven", kind: "program", config: { programKey: "Program.A", durationMinutes: 30 } });
    await valid.adapter.execute({ deviceId: valid.deviceId, capabilityId: "on", value: true });
    expect(valid.client.startProgram).toHaveBeenCalledWith("ha-1", "Program.A", [
      { key: "BSH.Common.Option.Duration", value: 1800 },
    ]);
  });

  it("runs the hood fan as the venting program at the configured stage", async () => {
    const { adapter, client, deviceId } = setup({
      type: "Hood",
      kind: "fan",
      config: { fanStage: "Cooking.Hood.EnumType.Stage.FanStage03" },
    });
    await adapter.execute({ deviceId, capabilityId: "on", value: true });
    expect(client.startProgram).toHaveBeenCalledWith("ha-1", "Cooking.Common.Program.Hood.Venting", [
      { key: "Cooking.Common.Option.Hood.VentingLevel", value: "Cooking.Hood.EnumType.Stage.FanStage03" },
    ]);
  });

  it("rejects commands for switches that are not enabled", async () => {
    const { adapter } = setup({ type: "Dishwasher", kind: "power" });
    await expect(
      adapter.execute({ deviceId: controlDeviceId("ha-1", "light"), capabilityId: "on", value: true }),
    ).rejects.toThrow(/not enabled/);
  });

  it("offers no control for hobs and requests no hob control scope", () => {
    expect(controlSpecsFor([{ haId: "h", type: "Hob" }])).toEqual([]);
    expect(HOME_CONNECT_CONTROL_SCOPES.some((scope) => scope.startsWith("Hob"))).toBe(false);
    expect(HOME_CONNECT_CONTROL_SCOPES).toContain("Dishwasher-Control");
  });
});
