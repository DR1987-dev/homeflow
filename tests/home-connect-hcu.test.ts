import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionDispatcher } from "../src/actions/action-dispatcher.js";
import { AdapterRegistry } from "../src/adapters/adapter-registry.js";
import { AllowListSafetyPolicy } from "../src/automation/support.js";
import { InMemoryEventBus } from "../src/events/event-bus.js";
import { HcuBridge, hcuDeviceId } from "../src/hcu/bridge.js";
import type { PluginMessage } from "../src/hcu/connect-api.js";
import { HomeConnectSetup } from "../src/hcu/home-connect-setup.js";
import { DeviceRegistry } from "../src/registry/device-registry.js";
import { StateStore } from "../src/state/state-store.js";

const POWER_ON = "BSH.Common.EnumType.PowerState.On";
const POWER_STANDBY = "BSH.Common.EnumType.PowerState.Standby";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("Home Connect appliances in the HCU app", () => {
  it("offers only enabled switches, and only included ones accept commands", async () => {
    let power = POWER_STANDBY;
    const writes: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/device_authorization")) {
        return json({ device_code: "d", user_code: "U", verification_uri: "https://v", expires_in: 300, interval: 1 });
      }
      if (url.endsWith("/security/oauth/token")) {
        return json({ access_token: "at", refresh_token: "rt", expires_in: 86400 });
      }
      if (url.endsWith("/homeappliances")) {
        return json({
          data: {
            homeappliances: [
              { haId: "ha-1", name: "Dishi", type: "Dishwasher", connected: true },
              { haId: "ha-2", name: "Kochfeld", type: "Hob", connected: true },
            ],
          },
        });
      }
      if (url.endsWith("/settings/BSH.Common.Setting.PowerState")) {
        if (init?.method === "PUT") {
          writes.push(JSON.parse(String(init.body)));
          power = JSON.parse(String(init.body)).data.value;
          return new Response(null, { status: 204 });
        }
        return json({ data: { value: power, constraints: { allowedvalues: [POWER_ON, POWER_STANDBY] } } });
      }
      return json({ data: { status: [] } });
    });
    vi.stubGlobal("fetch", fetcher);

    const bus = new InMemoryEventBus();
    const state = new StateStore(bus);
    const devices = new DeviceRegistry();
    const adapters = new AdapterRegistry();
    const setup = new HomeConnectSetup({
      pluginId: "p",
      dataFile: join(await mkdtemp(join(tmpdir(), "hc-e2e-")), "hc.json"),
      devices,
      adapters,
      bus,
      pollIntervalMs: 3_600_000,
      flow: { fetcher, sleep: async () => undefined },
    });
    const dispatcher = new ActionDispatcher(
      devices,
      adapters,
      new AllowListSafetyPolicy(() => setup.allowedControlPairs()),
    );
    const sent: PluginMessage[] = [];
    const bridge = new HcuBridge({
      pluginId: "p",
      devices,
      state,
      dispatcher,
      bus,
      send: (message) => sent.push(message),
    });
    bridge.start();

    await setup.update({ homeConnectClientId: "c", homeConnectControl: true });
    await setup.idle();
    const switchId = "home-connect-ctl:ha-1:power";
    await setup.update({ homeConnectClientId: "c", homeConnectControl: true, [`hcctl:${switchId}`]: true });

    const discover = await bridge.handle({ id: "1", pluginId: "p", type: "DISCOVER_REQUEST", body: {} });
    const offered = (discover?.body as { devices: { deviceId: string; deviceType: string; friendlyName: string }[] }).devices;
    expect(offered.map((device) => device.deviceType)).toEqual(["SWITCH"]);
    expect(offered[0]?.deviceId).toBe(hcuDeviceId(switchId));
    expect(offered[0]?.friendlyName).toBe("Dishi Ein/Aus");

    const control = (deviceId: string) =>
      bridge.handle({
        id: "2",
        pluginId: "p",
        type: "CONTROL_REQUEST",
        body: { deviceId, features: [{ type: "switchState", on: true }] },
      });

    expect((await control(hcuDeviceId(switchId)))?.body).toMatchObject({ success: false, error: { code: "UNKNOWN_DEVICE" } });
    expect(writes).toEqual([]);

    await bridge.handle({ id: "3", pluginId: "p", type: "INCLUSION_EVENT", body: { deviceIds: [hcuDeviceId(switchId)] } });
    expect((await control(hcuDeviceId(switchId)))?.body).toMatchObject({ success: true });
    expect(writes).toEqual([{ data: { key: "BSH.Common.Setting.PowerState", value: POWER_ON } }]);
    expect(state.get(switchId).get("on")).toBe(true);
    setup.stop();
  });
});
