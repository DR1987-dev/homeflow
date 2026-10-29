import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../src/adapters/adapter-registry.js";
import { HOME_CONNECT_SCOPES } from "../src/adapters/bosch/home-connect-device-flow.js";
import { InMemoryEventBus } from "../src/events/event-bus.js";
import { HomeConnectSetup } from "../src/hcu/home-connect-setup.js";
import { DeviceRegistry } from "../src/registry/device-registry.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeApi(tokenReplies: Response[]) {
  const bodies: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/device_authorization")) {
      bodies.push(String(init?.body));
      return json({
        device_code: "dc",
        user_code: "ABCD-1234",
        verification_uri: "https://verify.example",
        expires_in: 300,
        interval: 1,
      });
    }
    if (url.endsWith("/security/oauth/token")) {
      return tokenReplies.shift() ?? json({ error: "authorization_pending" });
    }
    if (url.endsWith("/homeappliances")) {
      return json({ data: { homeappliances: [{ haId: "ha-1", name: "Dishi", type: "Dishwasher", connected: true }] } });
    }
    return json({ data: { status: [{ key: "BSH.Common.Status.DoorState", value: "Closed" }] } });
  });
  return { fetcher, bodies };
}

async function setup(fetcher: typeof fetch) {
  vi.stubGlobal("fetch", fetcher);
  const dir = await mkdtemp(join(tmpdir(), "hc-setup-"));
  const devices = new DeviceRegistry();
  const adapters = new AdapterRegistry();
  const target = new HomeConnectSetup({
    pluginId: "p",
    dataFile: join(dir, "home-connect.json"),
    devices,
    adapters,
    bus: new InMemoryEventBus(),
    pollIntervalMs: 3_600_000,
    flow: { fetcher, sleep: async () => undefined },
  });
  return { target, devices, file: join(dir, "home-connect.json") };
}

afterEach(() => vi.unstubAllGlobals());

describe("HomeConnectSetup", () => {
  it("authorizes via device flow, registers read-only devices and persists tokens privately", async () => {
    const api = fakeApi([
      json({ error: "authorization_pending" }),
      json({ access_token: "at", refresh_token: "rt", expires_in: 86400 }),
    ]);
    const { target, devices, file } = await setup(api.fetcher);

    expect(await target.update({ homeConnectClientId: " client-1 " })).toEqual({ status: "APPLIED" });
    await target.idle();
    target.stop();

    expect(devices.get("home-connect:ha-1")?.name).toBe("Dishi");
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored.clientId).toBe("client-1");
    expect(stored.tokens.refreshToken).toBe("rt");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(api.bodies[0]).toContain(encodeURIComponent("IdentifyAppliance"));
    expect(HOME_CONNECT_SCOPES.some((scope) => /Control|Settings/.test(scope))).toBe(false);
  });

  it("shows the pending code in the template and reports denial without registering devices", async () => {
    const api = fakeApi([json({ error: "access_denied" })]);
    const { target, devices } = await setup(api.fetcher);

    await target.update({ homeConnectClientId: "client-1" });
    await target.idle();

    expect(devices.list()).toHaveLength(0);
    expect(target.template().groups.homeConnect.description).toContain("access_denied");
  });

  it("restores the connection from stored tokens on load", async () => {
    const api = fakeApi([json({ access_token: "at", refresh_token: "rt", expires_in: 86400 })]);
    const first = await setup(api.fetcher);
    await first.target.update({ homeConnectClientId: "c" });
    await first.target.idle();
    first.target.stop();

    const reloaded = new HomeConnectSetup({
      pluginId: "p",
      dataFile: first.file,
      devices: new DeviceRegistry(),
      adapters: new AdapterRegistry(),
      bus: new InMemoryEventBus(),
      pollIntervalMs: 3_600_000,
    });
    await reloaded.load();
    reloaded.stop();
    expect(reloaded.connected).toBe(true);
  });
});
