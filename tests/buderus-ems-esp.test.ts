import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmsEspAdapter } from "../src/adapters/buderus/ems-esp-adapter.js";
import { EmsEspApiError, EmsEspClient } from "../src/adapters/buderus/ems-esp-client.js";
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
      return json({ hc1: { seltemp: 20.5, currtemp: 19.8 } });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

afterEach(() => vi.unstubAllGlobals());

describe("EmsEspClient", () => {
  it("reads local boiler and thermostat values and forwards the optional API token", async () => {
    const { fetcher, requests } = emsEspFetch();
    const client = new EmsEspClient("http://ems-esp.local/", "api-token", fetcher);

    expect(await client.fetchDevice("boiler")).toEqual({
      device: "boiler",
      values: { curflowtemp: 48.5, heatingactive: "on" },
    });
    expect(await client.fetchDevice("thermostat")).toEqual({
      device: "thermostat",
      values: { hc1_seltemp: 20.5, hc1_currtemp: 19.8 },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://ems-esp.local/api/boiler/values",
      "http://ems-esp.local/api/thermostat/values",
    ]);
    expect(requests[0]?.headers.get("authorization")).toBe("api-token");
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
    ).rejects.toThrow("deaktiviert");
  });

  it("requires at least one reachable EMS device", async () => {
    const client = new EmsEspClient("http://ems-esp.local", undefined, async () => json({}, 404));
    await expect(new EmsEspAdapter(client).discover()).rejects.toThrow("weder einen Heizkessel noch einen Thermostat");
  });
});

describe("BuderusSetup", () => {
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
      await setup.update({ buderusGatewayUrl: "http://ems-esp.local", buderusAccessToken: "secret-token" }),
    ).toEqual({ status: "APPLIED" });
    setup.stop();

    expect(devices.list().map((device) => device.id)).toEqual(["emsesp:boiler", "emsesp:thermostat"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      gatewayUrl: "http://ems-esp.local",
      accessToken: "secret-token",
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(setup.template().groups.buderus.description).toContain("Steuerung ist deaktiviert");
  });
});
