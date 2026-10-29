import { describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../src/adapters/adapter-registry.js";
import {
  HomeConnectActionsBlockedError,
  HomeConnectAdapter,
} from "../src/adapters/bosch/home-connect-adapter.js";
import {
  HomeConnectApiError,
  HomeConnectAuthorizationError,
  HomeConnectClient,
} from "../src/adapters/bosch/home-connect-client.js";

const credentials = {
  clientId: "test-client",
  clientSecret: "test-secret",
  tokens: { accessToken: "access", refreshToken: "refresh" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Home Connect client and adapter", () => {
  it("discovers appliances and reports only observed read-only status features", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        data: {
          homeappliances: [{
            haId: "ha-1",
            name: "Dishwasher",
            brand: "BOSCH",
            type: "Dishwasher",
            connected: true,
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { status: [{ key: "BSH.Common.Status.OperationState", value: "Ready" }] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { homeappliance: { haId: "ha-1", connected: true } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { status: [{ key: "BSH.Common.Status.OperationState", value: "Run" }] },
      }));
    const adapter = new HomeConnectAdapter(new HomeConnectClient({ ...credentials, fetcher }));

    const devices = await adapter.discover();
    expect(devices).toEqual([{
      id: "home-connect:ha-1",
      adapterId: "bosch-home-connect",
      manufacturer: "BOSCH",
      model: "Dishwasher",
      name: "Dishwasher",
      capabilities: [
        {
          id: "connected",
          label: "Connected",
          type: "boolean",
          readable: true,
          writable: false,
          supportStatus: "SUPPORTED",
        },
        {
          id: "status:BSH.Common.Status.OperationState",
          label: "BSH.Common.Status.OperationState",
          type: "string",
          readable: true,
          writable: false,
          supportStatus: "SUPPORTED",
        },
      ],
    }]);

    await expect(adapter.readState("home-connect:ha-1")).resolves.toMatchObject([
      { capabilityId: "connected", value: true },
      { capabilityId: "status:BSH.Common.Status.OperationState", value: "Run" },
    ]);
  });

  it("does not call status for an appliance the API reports as offline", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        data: { homeappliances: [{ haId: "ha-offline", connected: false }] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { homeappliance: { haId: "ha-offline", connected: false } },
      }));
    const adapter = new HomeConnectAdapter(new HomeConnectClient({ ...credentials, fetcher }));

    await adapter.discover();
    await expect(adapter.readState("home-connect:ha-offline")).resolves.toMatchObject([
      { capabilityId: "connected", value: false },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refreshes an expired token and persists the new token set", async () => {
    const now = 1_800_000_000_000;
    const onTokens = vi.fn();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        access_token: "refreshed",
        refresh_token: "rotated",
        expires_in: 86_400,
      }))
      .mockResolvedValueOnce(jsonResponse({ data: { homeappliances: [] } }));
    const client = new HomeConnectClient({
      ...credentials,
      tokens: { accessToken: "expired", refreshToken: "refresh", expiresAt: now - 1 },
      onTokens,
      fetcher,
      now: () => now,
    });

    await expect(client.listAppliances()).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onTokens).toHaveBeenCalledWith({
      accessToken: "refreshed",
      refreshToken: "rotated",
      expiresAt: now + 86_400_000,
    });
  });

  it("requests the media type the Home Connect API accepts", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { homeappliances: [] } }));
    const client = new HomeConnectClient({ ...credentials, fetcher });

    await client.listAppliances();

    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Accept: "application/vnd.bsh.sdk.v1+json",
    });
  });

  it("surfaces API authorization failures instead of returning empty devices", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "unauthorized" }, 403));
    const client = new HomeConnectClient({ ...credentials, fetcher });

    await expect(client.listAppliances()).rejects.toMatchObject({
      name: "HomeConnectApiError",
      status: 403,
    } satisfies Partial<HomeConnectApiError>);
  });

  it("reports invalid refresh tokens explicitly", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));
    const client = new HomeConnectClient({
      ...credentials,
      tokens: { accessToken: "expired", refreshToken: "bad", expiresAt: 0 },
      fetcher,
      now: () => 10_000_000,
    });

    await expect(client.listAppliances()).rejects.toBeInstanceOf(HomeConnectAuthorizationError);
  });

  it("rejects all writes without issuing an API request", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { homeappliances: [] } }));
    const adapter = new HomeConnectAdapter(new HomeConnectClient({ ...credentials, fetcher }));
    await adapter.discover();

    await expect(adapter.execute({
      deviceId: "home-connect:ha-1",
      capabilityId: "program.start",
      value: "Coffee.Program.Espresso",
    })).rejects.toBeInstanceOf(HomeConnectActionsBlockedError);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("registers through the shared adapter registry", () => {
    const client = new HomeConnectClient({
      ...credentials,
      fetcher: vi.fn<typeof fetch>(),
    });
    const registry = new AdapterRegistry();
    const adapter = new HomeConnectAdapter(client);

    registry.register(adapter);

    expect(registry.get("bosch-home-connect")).toBe(adapter);
  });
});
