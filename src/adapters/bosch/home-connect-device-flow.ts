import { HomeConnectAuthorizationError, type HomeConnectTokens } from "./home-connect-client.js";

const DEVICE_AUTHORIZATION_URL = "https://api.home-connect.com/security/oauth/device_authorization";
const TOKEN_URL = "https://api.home-connect.com/security/oauth/token";

/** Read-only scopes only; no `-Control` or `-Settings` scope is ever requested. */
export const HOME_CONNECT_SCOPES = [
  "IdentifyAppliance",
  "Oven-Monitor",
  "Washer-Monitor",
  "Dryer-Monitor",
  "CoffeeMaker-Monitor",
  "Dishwasher-Monitor",
  "Hood-Monitor",
  "Hob-Monitor",
  "Refrigerator-Monitor",
  "FridgeFreezer-Monitor",
  "Freezer-Monitor",
  "WineCooler-Monitor",
];

export interface HomeConnectDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalSeconds: number;
}

export interface HomeConnectDeviceFlowOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function requestDeviceCode(
  clientId: string,
  scopes: readonly string[],
  options: HomeConnectDeviceFlowOptions = {},
): Promise<HomeConnectDeviceCode> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const response = await fetcher(DEVICE_AUTHORIZATION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: scopes.join(" ") }),
  });
  const body = await readObject(response);
  if (!response.ok) {
    throw new HomeConnectAuthorizationError(
      `Device authorization failed (HTTP ${response.status}): ${errorCode(body)}`,
    );
  }
  if (
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string" ||
    typeof body.expires_in !== "number"
  ) {
    throw new HomeConnectAuthorizationError("Device authorization response is missing required fields.");
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    ...(typeof body.verification_uri_complete === "string"
      ? { verificationUriComplete: body.verification_uri_complete }
      : {}),
    expiresAt: now() + body.expires_in * 1000,
    intervalSeconds: typeof body.interval === "number" ? body.interval : 5,
  };
}

export async function pollDeviceToken(
  clientId: string,
  code: HomeConnectDeviceCode,
  options: HomeConnectDeviceFlowOptions = {},
  clientSecret?: string,
): Promise<HomeConnectTokens> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let intervalMs = code.intervalSeconds * 1000;

  while (now() < code.expiresAt) {
    await sleep(intervalMs);
    const response = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "device_code",
        device_code: code.deviceCode,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      }),
    });
    const body = await readObject(response);

    if (response.ok && typeof body.access_token === "string") {
      return {
        accessToken: body.access_token,
        ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
        ...(typeof body.expires_in === "number" ? { expiresAt: now() + body.expires_in * 1000 } : {}),
      };
    }

    const error = errorCode(body);
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    throw new HomeConnectAuthorizationError(`Home Connect device authorization failed: ${error}.`);
  }

  throw new HomeConnectAuthorizationError("Home Connect device authorization timed out.");
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function errorCode(body: Record<string, unknown>): string {
  const error = body.error;
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && typeof (error as { description?: unknown }).description === "string") {
    return (error as { description: string }).description;
  }
  return "unknown_error";
}
