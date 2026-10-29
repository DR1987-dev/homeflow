import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../src/adapters/adapter-registry.js";
import { ShutterSelection } from "../src/automation/selection.js";
import { AllowListSafetyPolicy } from "../src/automation/support.js";
import { InMemoryEventBus } from "../src/events/event-bus.js";
import { HcuSystem } from "../src/hcu/system.js";
import { DeviceRegistry } from "../src/registry/device-registry.js";
import type { PluginMessage } from "../src/hcu/connect-api.js";

const channel = (index: number, extra: object) => ({ index, ...extra });
const state = {
  devices: {
    A: { id: "A", label: "Wohnzimmer", functionalChannels: { "1": channel(1, { shutterLevel: 0 }) } },
    B: { id: "B", label: "Küche", functionalChannels: { "1": channel(1, { shutterLevel: 0 }) } },
    L: { id: "L", label: "Lampe", functionalChannels: { "1": channel(1, { on: true }) } },
  },
  groups: {
    G1: { id: "G1", type: "SWITCHING", label: "Erdgeschoss", primaryShadingLevel: 0, channels: [{ deviceId: "A", channelIndex: 1 }, { deviceId: "B", channelIndex: 1 }] },
    G2: { id: "G2", type: "SWITCHING", label: "Lichter", channels: [{ deviceId: "L", channelIndex: 1 }] },
    G3: { id: "G3", type: "META", label: "Raum", channels: [{ deviceId: "A", channelIndex: 1 }] },
  },
};

async function setup() {
  const sent: PluginMessage[] = [];
  const devices = new DeviceRegistry();
  const system = new HcuSystem({
    pluginId: "p",
    send: (m) => void sent.push(m),
    bus: new InMemoryEventBus(),
    devices,
    adapters: new AdapterRegistry(),
  });
  const loading = system.load();
  await system.handle({ id: sent[0]!.id, pluginId: "p", type: "HMIP_SYSTEM_RESPONSE", body: { code: 200, body: state } });
  await loading;
  return { system, devices, sent };
}

describe("shading groups", () => {
  it("offers shutters and shutter groups only", async () => {
    const { devices } = await setup();
    expect(devices.list().map((d) => d.id).sort()).toEqual(["hcu-group:G1", "hcu:A:1", "hcu:B:1"]);
  });

  it("controls a group via setPrimaryShadingLevel", async () => {
    const { system, sent } = await setup();
    const executing = system.execute({ deviceId: "hcu-group:G1", capabilityId: "shutter_level", value: 1 });
    expect(sent.at(-1)!.body).toEqual({
      path: "/hmip/group/switching/setPrimaryShadingLevel",
      body: { groupId: "G1", primaryShadingLevel: 1 },
    });
    await system.handle({ id: sent.at(-1)!.id, pluginId: "p", type: "HMIP_SYSTEM_RESPONSE", body: { code: 200 } });
    await executing;
  });
});

describe("ShutterSelection", () => {
  it("renders checkboxes, persists changes and drives the safety policy", async () => {
    const { devices } = await setup();
    const file = join(await mkdtemp(join(tmpdir(), "hf-")), "sel.json");
    const selection = new ShutterSelection({ file, initial: ["hcu:A:1"], candidates: () => devices.list() });
    await selection.load();

    const template = selection.template();
    expect(Object.keys(template.properties).sort()).toEqual(["shutter:hcu-group:G1", "shutter:hcu:A:1", "shutter:hcu:B:1"]);
    expect(template.properties["shutter:hcu:A:1"]).toMatchObject({ dataType: "BOOLEAN", currentValue: "true", friendlyName: "Wohnzimmer" });

    const policy = new AllowListSafetyPolicy(() => selection.ids.map((deviceId) => ({ deviceId, capabilityId: "shutter_level" })));
    const ctx = (deviceId: string) => ({ command: { deviceId, capabilityId: "shutter_level", value: 1 } }) as never;
    expect(() => policy.authorize(ctx("hcu:B:1"))).toThrow();

    await selection.update({ "shutter:hcu:A:1": false, "shutter:hcu:B:1": true, "shutter:unknown": true });
    expect([...selection.ids]).toEqual(["hcu:B:1"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(["hcu:B:1"]);
    expect(() => policy.authorize(ctx("hcu:B:1"))).not.toThrow();
    expect(() => policy.authorize(ctx("hcu:A:1"))).toThrow();

    const reloaded = new ShutterSelection({ file, initial: [], candidates: () => devices.list() });
    await reloaded.load();
    expect([...reloaded.ids]).toEqual(["hcu:B:1"]);
  });
});
