import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AnkerCloudAdapter } from "../src/adapters/anker/anker-adapter.js";
import { AnkerCloudClient } from "../src/adapters/anker/anker-cloud-client.js";
import { AdapterPoller } from "../src/adapters/poller.js";
import { AdapterRegistry } from "../src/adapters/adapter-registry.js";
import { InMemoryEventBus, type HomeFlowEvents } from "../src/events/event-bus.js";
import { AnkerSetup } from "../src/hcu/anker-setup.js";
import { DeviceRegistry } from "../src/registry/device-registry.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function fakeCloud() {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    if (target.endsWith("passport/login")) {
      return json({ code: 0, data: { auth_token: "tok", user_id: "u1", token_expires_at: 4_102_444_800 } });
    }
    if (target.endsWith("get_site_list")) {
      return json({ code: 0, data: { site_list: [{ site_id: "s1" }] } });
    }
    return json({
      code: 0,
      data: {
        solarbank_info: {
          solarbank_list: [
            { device_sn: "ABC123", device_name: "Solarbank 3", device_pn: "A17C5", battery_power: "75", photovoltaic_power: "300", output_power: "120" },
          ],
        },
      },
    });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("AnkerCloudClient", () => {
  it("logs in with an encrypted password and reads solarbanks", async () => {
    const { calls, fetchImpl } = fakeCloud();
    const client = new AnkerCloudClient({ email: "a@b.de", password: "hunter2pw", country: "de" }, fetchImpl);

    const banks = await client.fetchSolarbanks();

    expect(banks).toEqual([
      { sn: "ABC123", name: "Solarbank 3", model: "A17C5", stateOfChargePercent: 75, photovoltaicPowerW: 300, outputPowerW: 120 },
    ]);
    const login = calls[0]!;
    expect(login.url).toBe("https://ankerpower-api-eu.anker.com/passport/login");
    expect(login.body.password).not.toBe("hunter2pw");
    expect(JSON.stringify(login.body)).not.toContain("hunter2pw");
    expect(calls[1]!.headers["x-auth-token"]).toBe("tok");
    expect(calls[1]!.headers.gtoken).toHaveLength(32);
  });

  it("raises API errors without leaking credentials", async () => {
    const fetchImpl = vi.fn(async () => json({ code: 100053, msg: "Wrong password" })) as unknown as typeof fetch;
    const client = new AnkerCloudClient({ email: "a@b.de", password: "secret", country: "DE" }, fetchImpl);

    await expect(client.fetchSolarbanks()).rejects.toThrow("Anker API error 100053");
  });
});

describe("AnkerCloudAdapter", () => {
  const banks = [{ sn: "ABC123", name: "SB3", model: "A17C5", stateOfChargePercent: 50, photovoltaicPowerW: undefined, outputPowerW: 10 }];
  const adapter = () => new AnkerCloudAdapter({ fetchSolarbanks: async () => banks });

  it("describes a read-only battery and skips unknown values", async () => {
    const [device] = await adapter().discover();
    expect(device).toMatchObject({ id: "anker-abc123", kind: "battery" });
    expect(device!.capabilities.every((capability) => !capability.writable)).toBe(true);

    const readings = await adapter().readState("anker-abc123");
    expect(readings.map((reading) => [reading.capabilityId, reading.value])).toEqual([
      ["battery_level", 50],
      ["output_power_w", 10],
    ]);
  });

  it("refuses control", async () => {
    await expect(adapter().execute({ deviceId: "anker-abc123", capabilityId: "x", value: 1 })).rejects.toThrow("read-only");
  });
});

describe("AdapterPoller", () => {
  it("publishes changes only once and tracks availability", async () => {
    const devices = new DeviceRegistry();
    const bus = new InMemoryEventBus();
    const events: HomeFlowEvents[keyof HomeFlowEvents][] = [];
    bus.subscribe("device.state.changed", (event) => void events.push(event));
    bus.subscribe("device.availability.changed", (event) => void events.push(event));

    let fail = false;
    const adapter = {
      id: "a",
      discover: async () => [],
      readState: async () => {
        if (fail) throw new Error("down");
        return [{ capabilityId: "c", value: 1, observedAt: "t" }];
      },
      execute: async () => undefined,
    };
    devices.register({ id: "d", adapterId: "a", manufacturer: "m", model: "m", name: "d", capabilities: [] });
    const poller = new AdapterPoller({ adapter, devices, bus, intervalMs: 1000 });

    await poller.pollOnce();
    await poller.pollOnce();
    fail = true;
    await poller.pollOnce();

    expect(events.map((event) => event.type)).toEqual([
      "device.availability.changed",
      "device.state.changed",
      "device.availability.changed",
    ]);
  });
});

describe("AnkerSetup", () => {
  it("requires configuration, then stores credentials privately and registers devices", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-"));
    const dataFile = join(dir, "anker.json");
    const devices = new DeviceRegistry();
    const setup = new AnkerSetup({
      pluginId: "p",
      dataFile,
      devices,
      adapters: new AdapterRegistry(),
      bus: new InMemoryEventBus(),
      pollIntervalMs: 3_600_000,
      createAdapter: () => new AnkerCloudAdapter({ fetchSolarbanks: async () => [{ sn: "X1", name: "SB", model: "A17C5", stateOfChargePercent: 1, photovoltaicPowerW: 0, outputPowerW: 0 }] }),
    });
    const msg = (type: string, body: unknown = {}) => ({ id: "1", pluginId: "p", type, body });

    expect((await setup.handle(msg("PLUGIN_STATE_REQUEST")))?.body).toEqual({ pluginReadinessStatus: "CONFIG_REQUIRED" });

    const rejected = await setup.handle(msg("CONFIG_UPDATE_REQUEST", { properties: { email: "a@b.de" } }));
    expect(rejected?.body).toMatchObject({ status: "FAILED" });

    const applied = await setup.handle(
      msg("CONFIG_UPDATE_REQUEST", { properties: { email: "a@b.de", password: "pw", country: "de" } }),
    );
    expect(applied?.body).toEqual({ status: "APPLIED" });
    expect(devices.list().map((device) => device.id)).toEqual(["anker-x1"]);
    expect(JSON.parse(await readFile(dataFile, "utf8"))).toMatchObject({ country: "DE" });
    expect((await stat(dataFile)).mode & 0o777).toBe(0o600);
    expect((await setup.handle(msg("PLUGIN_STATE_REQUEST")))?.body).toEqual({ pluginReadinessStatus: "READY" });
    expect(JSON.stringify(await setup.handle(msg("CONFIG_TEMPLATE_REQUEST")))).not.toContain("pw");
    setup.stop();
  });
});
