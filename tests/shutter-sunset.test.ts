import { describe, expect, it } from "vitest";
import { ActionDispatcher } from "../src/actions/action-dispatcher.js";
import { AdapterRegistry } from "../src/adapters/adapter-registry.js";
import type { DeviceAdapter } from "../src/adapters/device-adapter.js";
import { sunset } from "../src/astro/sun.js";
import { AutomationEngine, InMemoryRunStore, type GeoLocation } from "../src/automation/engine.js";
import {
  closeWindow,
  isCloseDue,
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

describe("close window", () => {
  it("spans sunset - early to sunset + late, fallback clamped into it", () => {
    const w = closeWindow(sunsetTime, config);
    expect([w.earliest, w.latest, w.fallback]).toEqual([at(-60), at(45), at(15)]);
    expect(closeWindow(sunsetTime, { ...config, baseOffsetMinutes: 200 }).fallback).toEqual(at(45));
    expect(closeWindow(sunsetTime, { ...config, baseOffsetMinutes: -200 }).fallback).toEqual(at(-60));
  });

  it("closes on darkness inside the window, never before it, at the end at the latest", () => {
    const w = closeWindow(sunsetTime, config);
    expect(isCloseDue(at(-61), w, 5, config)).toBe(false);
    expect(isCloseDue(at(-30), w, 5, config)).toBe(true);
    expect(isCloseDue(at(10), w, 219, config)).toBe(false);
    expect(isCloseDue(at(10), w, 40, config)).toBe(true);
    expect(isCloseDue(at(44), w, 5000, config)).toBe(false);
    expect(isCloseDue(at(45), w, 5000, config)).toBe(true);
    expect(isCloseDue(at(14), w, undefined, config)).toBe(false);
    expect(isCloseDue(at(15), w, undefined, config)).toBe(true);
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
    await setLux(20);
    setNow(at(-61));
    await engine.tick();
    expect(executed).toEqual([]);
    setNow(at(-55));
    await engine.tick();
    expect(executed).toEqual([{ deviceId: "shutter", capabilityId: SHUTTER_LEVEL, value: 1 }]);
  });

  it("waits while it is still bright (219 lx at sunset) and closes once it gets dark", async () => {
    const { engine, executed, setLux, setNow } = setup();
    await setLux(219);
    setNow(at(3));
    await engine.tick();
    expect(executed).toEqual([]);
    await setLux(35);
    setNow(at(25));
    await engine.tick();
    expect(executed).toHaveLength(1);
  });

  it("closes at the latest at the end of the window even when it stays bright", async () => {
    const { engine, executed, setLux, setNow } = setup();
    await setLux(20_000);
    setNow(at(44));
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
