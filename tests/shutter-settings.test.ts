import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENABLED_KEY, SENSOR_KEY, SettingsError, ShutterSettings } from "../src/automation/settings.js";
import { createShutterSunsetRule, DEFAULT_SHUTTER_CONFIG, type ShutterSunsetConfig } from "../src/automation/shutter-sunset.js";
import type { DeviceDefinition } from "../src/domain/device.js";

const sensor = (id: string, name: string): DeviceDefinition => ({
  id,
  adapterId: "hcu-system",
  manufacturer: "eQ-3",
  model: "SWO",
  name,
  capabilities: [{ id: "illuminance_lux", label: "Lux", type: "number", readable: true, writable: false }],
});
const location = { latitude: 53.24, longitude: 7.52, timeZone: "Europe/Berlin" };

async function setup(sensors: DeviceDefinition[] = [sensor("hcu:S:1", "Wetterstation")]) {
  const file = join(await mkdtemp(join(tmpdir(), "hf-")), "settings.json");
  const config: ShutterSunsetConfig = { ...DEFAULT_SHUTTER_CONFIG, enabled: true, shutterDeviceIds: [], sensorDeviceId: "" };
  let enabled = true;
  let done = false;
  const rule = createShutterSunsetRule(config, () => [], () => settings.sensorId());
  const settings: ShutterSettings = new ShutterSettings({
    file,
    config,
    candidates: () => sensors,
    isEnabled: () => enabled,
    doneToday: () => done,
    setEnabled: async (value) => void (enabled = value),
    status: () => rule,
    location: () => location,
    now: () => new Date("2026-06-21T12:00:00Z"),
  });
  return { settings, config, file, isEnabled: () => enabled, rule, setDone: (value: boolean) => void (done = value) };
}

describe("ShutterSettings", () => {
  it("auto-selects a single sensor and shows status and current values", async () => {
    const { settings } = await setup();
    expect(settings.sensorId()).toBe("hcu:S:1");
    const { properties } = settings.template() as { properties: Record<string, any> };
    expect(properties[ENABLED_KEY].currentValue).toBe("true");
    expect(properties["setting:baseOffsetMinutes"]).toMatchObject({ dataType: "INTEGER", currentValue: "15" });
    expect(properties[SENSOR_KEY].values).toEqual(["Wetterstation [hcu:S:1]"]);
    expect(properties["status:close"].currentValue).toMatch(/^\d{2}:\d{2} Uhr$/);
    expect(properties["status:lux"].currentValue).toBe("kein aktueller Messwert");
  });

  it("shows tomorrow's time once today's closing is done", async () => {
    const { settings, setDone } = await setup();
    const text = () => (settings.template() as { properties: Record<string, any> }).properties["status:close"].currentValue as string;
    expect(text()).toMatch(/^\d{2}:\d{2} Uhr$/);
    setDone(true);
    expect(text()).toMatch(/^heute erledigt; morgen ca\. \d{2}:\d{2} Uhr/);
  });

  it("requires an explicit choice with several sensors", async () => {
    const { settings } = await setup([sensor("a", "A"), sensor("b", "B")]);
    expect(settings.sensorId()).toBeUndefined();
  });

  it("applies, persists and reloads settings; the rule sees them immediately", async () => {
    const { settings, config, file, isEnabled, rule } = await setup();
    const before = rule.plannedCloseTime({ now: new Date("2026-06-21T12:00:00Z"), location })!;
    await settings.update({ "setting:baseOffsetMinutes": 30, "setting:lateMinutes": "45", [ENABLED_KEY]: false });
    expect(config.baseOffsetMinutes).toBe(30);
    expect(config.lateMinutes).toBe(45);
    expect(isEnabled()).toBe(false);
    const after = rule.plannedCloseTime({ now: new Date("2026-06-21T12:00:00Z"), location })!;
    expect(after.getTime() - before.getTime()).toBe(15 * 60_000);
    expect(JSON.parse(await readFile(file, "utf8")).baseOffsetMinutes).toBe(30);

    const fresh = await setup();
    await fresh.settings.update({});
    const reloaded: ShutterSunsetConfig = { ...DEFAULT_SHUTTER_CONFIG, enabled: true, shutterDeviceIds: [], sensorDeviceId: "" };
    const again = new ShutterSettings({
      file, config: reloaded, candidates: () => [], isEnabled: () => true, doneToday: () => false, setEnabled: async () => undefined,
      status: () => undefined, location: () => undefined,
    });
    await again.load();
    expect(reloaded.baseOffsetMinutes).toBe(30);
  });

  it("rejects invalid input without changing anything", async () => {
    const { settings, config, file } = await setup();
    await expect(settings.update({ "setting:baseOffsetMinutes": 999 })).rejects.toBeInstanceOf(SettingsError);
    await expect(settings.update({ "setting:darkLux": 2000, "setting:brightLux": 500 })).rejects.toThrow(/kleiner/);
    await expect(settings.update({ [SENSOR_KEY]: "Fremd [x]" })).rejects.toThrow(/sensor/i);
    expect(config.baseOffsetMinutes).toBe(15);
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });
});
