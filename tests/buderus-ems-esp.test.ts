import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmsEspAdapter } from "../src/adapters/buderus/ems-esp-adapter.js";
import { EmsEspApiError, EmsEspClient, normalizeGatewayUrl } from "../src/adapters/buderus/ems-esp-client.js";
import { AdapterRegistry } from "../src/adapters/adapter-registry.js";
import { InMemoryEventBus } from "../src/events/event-bus.js";
import { BuderusSetup } from "../src/hcu/buderus-setup.js";
import { DeviceRegistry } from "../src/registry/device-registry.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function emsEspFetch() {
  const requests: { url: string; headers: Headers }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    const url = String(input);
    if (url.endsWith("/api/boiler/values")) {
      return json({ curflowtemp: 48.5, heatingactive: "on" });
    }
    if (url.endsWith("/api/thermostat/values")) {
      return json({ hc2: { seltemp: 20.5, currtemp: 19.8 } });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

afterEach(() => vi.unstubAllGlobals());

describe("EmsEspClient", () => {
  it("normalizes bare addresses and duplicated HTTP schemes", () => {
    expect(normalizeGatewayUrl("192.168.178.99")).toBe("http://192.168.178.99");
    expect(normalizeGatewayUrl("http://http://192.168.178.99")).toBe("http://192.168.178.99");
  });

  it("reads local boiler and thermostat values and forwards the optional API token", async () => {
    const { fetcher, requests } = emsEspFetch();
    const client = new EmsEspClient("http://ems-esp.local/", "api-token", fetcher);

    expect(await client.fetchDevice("boiler")).toEqual({
      device: "boiler",
      values: { curflowtemp: 48.5, heatingactive: "on" },
    });
    expect(await client.fetchDevice("thermostat")).toEqual({
      device: "thermostat",
      values: { hc2_seltemp: 20.5, hc2_currtemp: 19.8 },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://ems-esp.local/api/boiler/values",
      "http://ems-esp.local/api/thermostat/values",
    ]);
    expect(requests[0]?.headers.get("authorization")).toBe("api-token");
  });

  it("writes only through the documented EMS-ESP heating circuit endpoint", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => json({}));
    const client = new EmsEspClient("http://ems-esp.local", "write-token", fetcher as unknown as typeof fetch);

    await client.setThermostatHc2Setpoint(21.5);

    const [url, options] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://ems-esp.local/api/thermostat/hc2/seltemp");
    expect(options?.method).toBe("POST");
    expect(options?.body).toBe(JSON.stringify({ data: 21.5 }));
    expect(new Headers(options?.headers).get("authorization")).toBe("write-token");
  });

  it("treats a missing device endpoint as absent and reports other API errors", async () => {
    const missing = new EmsEspClient("http://ems-esp.local", undefined, async () => json({}, 404));
    await expect(missing.fetchDevice("thermostat")).resolves.toBeUndefined();

    const failed = new EmsEspClient("http://ems-esp.local", undefined, async () => json({}, 401));
    await expect(failed.fetchDevice("boiler")).rejects.toMatchObject({ status: 401 });
  });

  it("rejects malformed or credential-bearing gateway URLs", () => {
    expect(() => new EmsEspClient("not a url")).toThrow(EmsEspApiError);
    expect(() => new EmsEspClient("http://user:pass@ems-esp.local")).toThrow(EmsEspApiError);
  });
});

describe("EmsEspAdapter", () => {
  it("discovers available EMS-ESP devices and maps thermostat setpoint", async () => {
    const { fetcher } = emsEspFetch();
    const adapter = new EmsEspAdapter(new EmsEspClient("http://ems-esp.local", undefined, fetcher));

    const devices = await adapter.discover();
    expect(devices.map((device) => device.id)).toEqual(["emsesp:boiler", "emsesp:thermostat"]);
    expect(devices[0]?.kind).toBeUndefined();
    expect(devices[0]?.capabilities).toContainEqual(
      expect.objectContaining({ id: "emsesp_boiler_curflowtemp", readable: true, writable: false }),
    );
    expect(devices[1]).toMatchObject({
      kind: "thermostat",
      capabilities: expect.arrayContaining([
        expect.objectContaining({ id: "target_temperature_c", label: "Solltemperatur" }),
      ]),
    });
    await expect(adapter.readState("emsesp:thermostat")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capabilityId: "target_temperature_c", value: 20.5 }),
      ]),
    );
    await expect(
      adapter.execute({ deviceId: "emsesp:thermostat", capabilityId: "target_temperature_c", value: 21 }),
    ).rejects.toThrow("freigegebene");
  });

  it("marks only the RC35 HC2 setpoint writable after explicit enablement", async () => {
    const { fetcher } = emsEspFetch();
    const adapter = new EmsEspAdapter(new EmsEspClient("http://ems-esp.local", undefined, fetcher), true);

    const thermostat = (await adapter.discover()).find((device) => device.id === "emsesp:thermostat");
    expect(thermostat?.capabilities).toContainEqual(
      expect.objectContaining({
        id: "target_temperature_c",
        writable: true,
        min: 5,
        max: 25,
      }),
    );
    await expect(
      adapter.execute({ deviceId: "emsesp:thermostat", capabilityId: "target_temperature_c", value: 25.5 }),
    ).rejects.toThrow("freigegebene");
  });

  it("sends an enabled in-range setpoint through EMS-ESP", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init && { init }) });
      if (url.endsWith("/values")) {
        return json(url.includes("/boiler/")
          ? { curflowtemp: 50 }
          : { hc2: { seltemp: 21.5, currtemp: 21.8 } });
      }
      return json({ success: true });
    }) as unknown as typeof fetch;
    const adapter = new EmsEspAdapter(new EmsEspClient("http://ems-esp.local", "token", fetcher), true);

    await adapter.discover();
    await adapter.execute({
      deviceId: "emsesp:thermostat",
      capabilityId: "target_temperature_c",
      value: 22,
    });

    const write = calls.find((call) => call.init?.method === "POST");
    expect(write?.url).toBe("http://ems-esp.local/api/thermostat/hc2/seltemp");
    expect(write?.init?.body).toBe(JSON.stringify({ data: 22 }));
    expect(new Headers(write?.init?.headers).get("authorization")).toBe("token");
  });

  it("requires at least one reachable EMS device", async () => {
    const client = new EmsEspClient("http://ems-esp.local", undefined, async () => json({}, 404));
    await expect(new EmsEspAdapter(client).discover()).rejects.toThrow("weder einen Heizkessel noch einen Thermostat");
  });
});

describe("BuderusSetup", () => {
  it("requires an API token before enabling RC35 control", async () => {
    const dir = await mkdtemp(join(tmpdir(), "buderus-no-token-"));
    const { fetcher } = emsEspFetch();
    vi.stubGlobal("fetch", fetcher);
    const setup = new BuderusSetup({
      dataFile: join(dir, "buderus.json"),
      devices: new DeviceRegistry(),
      adapters: new AdapterRegistry(),
      bus: new InMemoryEventBus(),
    });

    await expect(
      setup.update({
        buderusGatewayUrl: "192.168.178.99",
        buderusControlSetpointHc2: true,
      }),
    ).resolves.toMatchObject({ status: "FAILED", message: expect.stringContaining("API-Token") });
    expect(setup.allowedControlPairs()).toEqual([]);
  });

  it("configures the gateway, discovers devices and stores configuration privately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "buderus-"));
    const file = join(dir, "buderus.json");
    const { fetcher } = emsEspFetch();
    vi.stubGlobal("fetch", fetcher);
    const devices = new DeviceRegistry();
    const setup = new BuderusSetup({
      dataFile: file,
      devices,
      adapters: new AdapterRegistry(),
      bus: new InMemoryEventBus(),
      pollIntervalMs: 3_600_000,
    });

    expect((await setup.update({ buderusGatewayUrl: "", buderusAccessToken: "" })).status).toBe("APPLIED");
    expect(
      await setup.update({
        buderusGatewayUrl: "http://http://ems-esp.local",
        buderusAccessToken: "secret-token",
      }),
    ).toEqual({ status: "APPLIED" });
    setup.stop();

    expect(devices.list().map((device) => device.id)).toEqual(["emsesp:boiler", "emsesp:thermostat"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      gatewayUrl: "http://ems-esp.local",
      accessToken: "secret-token",
      controlSetpointHc2: false,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(setup.template().properties.buderusControlSetpointHc2).toMatchObject({ currentValue: "false" });
    expect(setup.allowedControlPairs()).toEqual([]);
    expect(await setup.update({ buderusControlSetpointHc2: true })).toEqual({ status: "APPLIED" });
    expect(setup.allowedControlPairs()).toEqual([
      { deviceId: "emsesp:thermostat", capabilityId: "target_temperature_c" },
    ]);
    expect(devices.get("emsesp:thermostat")?.capabilities).toContainEqual(
      expect.objectContaining({ id: "target_temperature_c", writable: true }),
    );
    expect(JSON.parse(await readFile(file, "utf8")).controlSetpointHc2).toBe(true);
    await setup.update({ buderusControlSetpointHc2: false });
    expect(setup.allowedControlPairs()).toEqual([]);
  });
});
