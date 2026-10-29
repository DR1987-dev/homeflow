import { describe, expect, it } from "vitest";
import { ActionDispatcher } from "../src/actions/action-dispatcher.js";
import { AdapterRegistry } from "../src/adapters/adapter-registry.js";
import type { DeviceAdapter } from "../src/adapters/device-adapter.js";
import { sunset } from "../src/astro/sun.js";
import { AutomationEngine, InMemoryRunStore, type GeoLocation } from "../src/automation/engine.js";
import {
  brightnessOffsetMinutes,
  closeTime,
  createShutterSunsetRule,
  DEFAULT_SHUTTER_CONFIG,
  ILLUMINANCE,
  SHUTTER_LEVEL,
  type ShutterSunsetConfig,
} from "../src/automation/shutter-sunset.js";
import { AllowListSafetyPolicy } from "../src/automation/support.js";
import type { DeviceCommand } from "../src/domain/device.js";
import { InMemoryEventBus } from "../src/events/event-bus.js";
import { DeviceRegistry } from "../src/registry/device-registry.js";
import { StateStore } from "../src/state/state-store.js";

const config: ShutterSunsetConfig = {
  ...DEFAULT_SHUTTER_CONFIG,
  enabled: true,
  shutterDeviceIds: ["shutter"],
  sensorDeviceId: "station",
};
const location: GeoLocation = { latitude: 53.24, longitude: 7.52, timeZone: "Europe/Berlin" };
const day = { year: 2026, month: 6, day: 21 };
const sunsetTime = sunset(day, location.latitude, location.longitude)!;
const at = (minutesFromSunset: number) => new Date(sunsetTime.getTime() + minutesFromSunset * 60_000);

describe("brightness offset", () => {
  it("shifts earlier when dark, later when bright, interpolates between", () => {
    expect(brightnessOffsetMinutes(20, config)).toBe(-60);
    expect(brightnessOffsetMinutes(50_000, config)).toBe(30);
    expect(brightnessOffsetMinutes(550, config)).toBe(-15);
    expect(brightnessOffsetMinutes(undefined, config)).toBe(0);
  });

  it("combines with the base offset", () => {
    expect(closeTime(sunsetTime, 20, config)).toEqual(at(-45));
    expect(closeTime(sunsetTime, 5000, config)).toEqual(at(45));
    expect(closeTime(sunsetTime, undefined, config)).toEqual(at(15));
  });
});

function setup() {
  const bus = new InMemoryEventBus();
  const state = new StateStore(bus);
  const devices = new DeviceRegistry();
  const adapters = new AdapterRegistry();
  const executed: DeviceCommand[] = [];
  const adapter: DeviceAdapter = {
    id: "test",
    discover: async () => [],
    readState: async () => [],
    execute: async (command) => void executed.push(command),
  };
  adapters.register(adapter);
  devices.register({
    id: "shutter",
    adapterId: "test",
    manufacturer: "t",
    model: "t",
    name: "Shutter",
    capabilities: [
      { id: SHUTTER_LEVEL, label: "level", type: "number", readable: true, writable: true, min: 0, max: 1 },
    ],
  });
  const dispatcher = new ActionDispatcher(
    devices,
    adapters,
    new AllowListSafetyPolicy([{ deviceId: "shutter", capabilityId: SHUTTER_LEVEL }]),
  );
  let now = at(0);
  const rule = createShutterSunsetRule(config);
  const engine = new AutomationEngine({
    rules: [rule],
    state,
    dispatcher,
    runStore: new InMemoryRunStore(),
    getLocation: () => location,
    now: () => now,
  });
  const setLux = (value: number) =>
    bus.publish({ type: "device.state.changed", deviceId: "station", capabilityId: ILLUMINANCE, value, observedAt: "" });
  const setLevel = (value: number) =>
    bus.publish({ type: "device.state.changed", deviceId: "shutter", capabilityId: SHUTTER_LEVEL, value, observedAt: "" });
  return { engine, executed, setLux, setLevel, setNow: (date: Date) => (now = date) };
}

describe("shutter sunset automation", () => {
  it("closes early on a dark, overcast evening", async () => {
    const { engine, executed, setLux, setNow } = setup();
    await setLux(50);
    setNow(at(-50));
    await engine.tick();
    expect(executed).toEqual([]);
    setNow(at(-45));
    await engine.tick();
    expect(executed).toEqual([{ deviceId: "shutter", capabilityId: SHUTTER_LEVEL, value: 1 }]);
  });

  it("waits longer on a bright summer evening", async () => {
    const { engine, executed, setLux, setNow } = setup();
    await setLux(20_000);
    setNow(at(30));
    await engine.tick();
    expect(executed).toEqual([]);
    setNow(at(45));
    await engine.tick();
    expect(executed).toHaveLength(1);
  });

  it("uses the neutral offset without sensor data", async () => {
    const { engine, executed, setNow } = setup();
    setNow(at(14));
    await engine.tick();
    expect(executed).toEqual([]);
    setNow(at(15));
    await engine.tick();
    expect(executed).toHaveLength(1);
  });

  it("closes only once per day, even if the user reopens", async () => {
    const { engine, executed, setNow, setLevel } = setup();
    setNow(at(20));
    await engine.tick();
    await setLevel(0);
    setNow(at(25));
    await engine.tick();
    expect(executed).toHaveLength(1);
  });

  it("does nothing when the shutter is already closed, and does not retry", async () => {
    const { engine, executed, setNow, setLevel } = setup();
    await setLevel(1);
    setNow(at(20));
    await engine.tick();
    await setLevel(0);
    setNow(at(25));
    await engine.tick();
    expect(executed).toEqual([]);
  });

  it("is blocked by the safety policy for other devices", async () => {
    const policy = new AllowListSafetyPolicy([{ deviceId: "shutter", capabilityId: SHUTTER_LEVEL }]);
    expect(() =>
      policy.authorize({ command: { deviceId: "other", capabilityId: SHUTTER_LEVEL, value: 1 } } as never),
    ).toThrow(/not permitted/);
  });
});

describe("automation switch", () => {
  it("skips the rule while disabled and persists the state", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { AutomationSwitch } = await import("../src/automation/switch.js");

    const dir = await mkdtemp(join(tmpdir(), "hf-"));
    const file = join(dir, "switches.json");
    const make = () => {
      const bus = new InMemoryEventBus();
      const devices = new DeviceRegistry();
      const sw = new AutomationSwitch({
        deviceId: "automation:x",
        name: "x",
        file,
        defaultOn: true,
        devices,
        adapters: new AdapterRegistry(),
        bus,
      });
      return { sw, bus, state: new StateStore(bus) };
    };

    const first = make();
    await first.sw.load();
    expect(first.sw.enabled).toBe(true);
    await first.sw.execute({ deviceId: "automation:x", capabilityId: "on", value: false });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "automation:x": false });

    const second = make();
    await second.sw.load();
    expect(second.sw.enabled).toBe(false);

    const executed: DeviceCommand[] = [];
    const rule = { ...createShutterSunsetRule(config), isEnabled: () => second.sw.enabled };
    const engine = new AutomationEngine({
      rules: [rule],
      state: second.state,
      dispatcher: { dispatch: async (c: DeviceCommand) => void executed.push(c) } as unknown as ActionDispatcher,
      runStore: new InMemoryRunStore(),
      getLocation: () => location,
      now: () => at(60),
    });
    await engine.tick();
    expect(executed).toEqual([]);
  });
});
