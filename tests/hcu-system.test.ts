import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../src/adapters/adapter-registry.js";
import { InMemoryEventBus, type HomeFlowEvents } from "../src/events/event-bus.js";
import type { PluginMessage } from "../src/hcu/connect-api.js";
import { HcuSystem } from "../src/hcu/system.js";
import { DeviceRegistry } from "../src/registry/device-registry.js";

const systemState = {
  home: { timeZoneId: "Europe/Berlin", location: { latitude: "53.24335", longitude: "7.52207" } },
  devices: {
    SWO: {
      id: "SWO",
      label: "Wetterstation",
      modelType: "HmIP-SWO-PRO",
      functionalChannels: {
        "0": { index: 0, unreach: false },
        "1": { index: 1, functionalChannelType: "WEATHER_SENSOR_PRO_CHANNEL", averageIllumination: 420 },
      },
    },
    ROL: {
      id: "ROL",
      label: "Rollladen",
      modelType: "HmIP-BROLL",
      functionalChannels: {
        "0": { index: 0, unreach: false },
        "1": { index: 1, functionalChannelType: "SHUTTER_CHANNEL", shutterLevel: 0 },
      },
    },
    LAMP: { id: "LAMP", functionalChannels: { "1": { index: 1, on: true } } },
  },
};

function setup() {
  const sent: PluginMessage[] = [];
  const events: HomeFlowEvents["device.state.changed"][] = [];
  const bus = new InMemoryEventBus();
  bus.subscribe("device.state.changed", (event) => void events.push(event));
  const devices = new DeviceRegistry();
  const system = new HcuSystem({
    pluginId: "p",
    send: (message) => void sent.push(message),
    bus,
    devices,
    adapters: new AdapterRegistry(),
  });
  const respond = (body: unknown) => system.handle({ id: sent.at(-1)!.id, pluginId: "p", type: "HMIP_SYSTEM_RESPONSE", body });
  return { system, sent, events, devices, respond };
}

describe("HcuSystem", () => {
  it("loads location, sensors and shutters from the system state", async () => {
    const { system, events, devices, respond, sent } = setup();
    const loading = system.load();
    expect((sent[0]!.body as { path: string }).path).toBe("/hmip/home/getSystemState");
    await respond({ code: 200, body: systemState });
    await loading;

    expect(system.location).toEqual({ latitude: 53.24335, longitude: 7.52207, timeZone: "Europe/Berlin" });
    expect(devices.list().map((d) => d.id).sort()).toEqual(["hcu:ROL:1", "hcu:SWO:1"]);
    expect(events).toContainEqual(expect.objectContaining({ deviceId: "hcu:SWO:1", capabilityId: "illuminance_lux", value: 420 }));
  });

  it("applies system events and publishes only changed values", async () => {
    const { system, events, respond } = setup();
    const loading = system.load();
    await respond({ code: 200, body: systemState });
    await loading;
    events.length = 0;

    const changed = (lux: number) => ({
      id: "e",
      pluginId: "p",
      type: "HMIP_SYSTEM_EVENT",
      body: {
        eventTransaction: {
          events: {
            "0": {
              pushEventType: "DEVICE_CHANGED",
              device: {
                id: "SWO",
                functionalChannels: { "1": { index: 1, averageIllumination: lux } },
              },
            },
          },
        },
      },
    });
    await system.handle(changed(420));
    await system.handle(changed(150));
    expect(events.map((e) => e.value)).toEqual([150]);
  });

  it("sends shutter commands through the HCU system request", async () => {
    const { system, sent, respond } = setup();
    const loading = system.load();
    await respond({ code: 200, body: systemState });
    await loading;

    const executing = system.execute({ deviceId: "hcu:ROL:1", capabilityId: "shutter_level", value: 1 });
    expect(sent.at(-1)!.body).toEqual({
      path: "/hmip/device/control/setShutterLevel",
      body: { deviceId: "ROL", channelIndex: 1, shutterLevel: 1 },
    });
    await respond({ code: 200 });
    await executing;
  });

  it("logs numeric fields of a weather channel with an unknown brightness field once", async () => {
    const logs: string[] = [];
    const sent: PluginMessage[] = [];
    const system = new HcuSystem({
      pluginId: "p",
      send: (m) => void sent.push(m),
      bus: new InMemoryEventBus(),
      devices: new DeviceRegistry(),
      adapters: new AdapterRegistry(),
      log: (line) => void logs.push(line),
    });
    const device = {
      id: "W",
      functionalChannels: { "1": { index: 1, functionalChannelType: "WEATHER_SENSOR_PRO_CHANNEL", lightLevel: 7, windSpeed: 3 } },
    };
    const event = { id: "e", pluginId: "p", type: "HMIP_SYSTEM_EVENT", body: { eventTransaction: { events: { "0": { pushEventType: "DEVICE_CHANGED", device } } } } };
    await system.handle(event);
    await system.handle(event);
    expect(logs.filter((l) => l.includes("no known brightness field"))).toHaveLength(1);
    expect(logs.join("\n")).toContain("lightLevel=7");
  });

  it("rejects when the HCU answers with an error", async () => {
    const { system, respond } = setup();
    const loading = system.load();
    await respond({ code: 400 });
    await expect(loading).rejects.toThrow(/rejected/);
  });
});
