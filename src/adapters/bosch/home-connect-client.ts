const API_BASE_URL = "https://api.home-connect.com/api";
const TOKEN_URL = "https://api.home-connect.com/security/oauth/token";
const TOKEN_EXPIRY_SKEW_MS = 60_000;

export interface HomeConnectTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface HomeConnectClientOptions {
  clientId: string;
  clientSecret?: string;
  tokens: HomeConnectTokens;
  onTokens?: (tokens: HomeConnectTokens) => void | Promise<void>;
  fetcher?: typeof fetch;
  now?: () => number;
}

export class HomeConnectAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeConnectAuthorizationError";
  }
}

export class HomeConnectApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HomeConnectApiError";
  }
}

export class HomeConnectProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeConnectProtocolError";
  }
}

export interface HomeConnectAppliance {
  haId: string;
  name?: string;
  brand?: string;
  type?: string;
  vib?: string;
  connected?: boolean;
}

export interface HomeConnectStatusFeature {
  key: string;
  value: boolean | number | string;
}

export class HomeConnectClient {
  private tokens: HomeConnectTokens;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private refreshInFlight: Promise<string> | undefined;

  constructor(private readonly options: HomeConnectClientOptions) {
    if (!options.clientId.trim()) {
      throw new HomeConnectAuthorizationError("A Home Connect client ID is required.");
    }
    if (!options.tokens.accessToken.trim()) {
      throw new HomeConnectAuthorizationError("A Home Connect access token is required.");
    }

    this.tokens = { ...options.tokens };
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async listAppliances(): Promise<readonly HomeConnectAppliance[]> {
    const body = await this.request("/homeappliances");
    const data = record(body.data);
    if (!Array.isArray(data.homeappliances)) {
      throw new HomeConnectProtocolError("Home Connect appliance list has an invalid shape.");
    }

    return data.homeappliances.map(parseAppliance);
  }

  async getAppliance(haId: string): Promise<HomeConnectAppliance> {
    const body = await this.request(`/homeappliances/${encodeURIComponent(haId)}`);
    return parseAppliance(body.data);
  }

  async getStatus(haId: string): Promise<readonly HomeConnectStatusFeature[]> {
    const body = await this.request(`/homeappliances/${encodeURIComponent(haId)}/status`);
    const data = record(body.data);
    if (!Array.isArray(data.status)) {
      throw new HomeConnectProtocolError("Home Connect appliance status has an invalid shape.");
    }

    return data.status.flatMap((item): HomeConnectStatusFeature[] => {
      const feature = record(item);
      if (
        typeof feature.key !== "string" ||
        (typeof feature.value !== "boolean" &&
          typeof feature.value !== "number" &&
          typeof feature.value !== "string")
      ) {
        return [];
      }
      return [{ key: feature.key, value: feature.value }];
    });
  }

  private async request(path: string): Promise<Record<string, unknown>> {
    let token = await this.accessToken();
    let response = await this.sendApiRequest(path, token);

    if (response.status === 401 && this.tokens.refreshToken) {
      token = await this.refreshAccessToken();
      response = await this.sendApiRequest(path, token);
    }

    if (!response.ok) {
      throw new HomeConnectApiError(
        `Home Connect API request failed with HTTP ${response.status}.`,
        response.status,
      );
    }

    return parseJsonObject(response, "Home Connect API response");
  }

  private async sendApiRequest(path: string, token: string): Promise<Response> {
    return this.fetcher(`${API_BASE_URL}${path}`, {
      headers: {
        Accept: "application/vnd.bsh.sdk.v1+json",
        Authorization: `Bearer ${token}`,
      },
    });
  }

  private async accessToken(): Promise<string> {
    const expiresAt = this.tokens.expiresAt;
    if (expiresAt !== undefined && expiresAt <= this.now() + TOKEN_EXPIRY_SKEW_MS) {
      return this.refreshAccessToken();
    }
    return this.tokens.accessToken;
  }

  private async refreshAccessToken(): Promise<string> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    if (!this.tokens.refreshToken) {
      throw new HomeConnectAuthorizationError(
        "The Home Connect access token expired and no refresh token is configured.",
      );
    }

    this.refreshInFlight = this.refresh();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private async refresh(): Promise<string> {
    const refreshToken = this.tokens.refreshToken;
    if (!refreshToken) {
      throw new HomeConnectAuthorizationError(
        "The Home Connect access token expired and no refresh token is configured.",
      );
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}),
    });
    const response = await this.fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new HomeConnectAuthorizationError(
        `Home Connect token refresh failed with HTTP ${response.status}.`,
      );
    }

    const result = await parseJsonObject(response, "Home Connect token response");
    if (typeof result.access_token !== "string" || !result.access_token) {
      throw new HomeConnectProtocolError("Home Connect token response has no access token.");
    }

    const tokens: HomeConnectTokens = {
      accessToken: result.access_token,
      ...(typeof result.refresh_token === "string"
        ? { refreshToken: result.refresh_token }
        : { refreshToken }),
      ...(typeof result.expires_in === "number"
        ? { expiresAt: this.now() + result.expires_in * 1000 }
        : {}),
    };
    this.tokens = tokens;
    await this.options.onTokens?.({ ...tokens });
    return tokens.accessToken;
  }
}

function parseAppliance(value: unknown): HomeConnectAppliance {
  const appliance = record(value);
  if (typeof appliance.haId !== "string" || !appliance.haId) {
    throw new HomeConnectProtocolError("Home Connect appliance has no valid haId.");
  }

  return {
    haId: appliance.haId,
    ...(typeof appliance.name === "string" ? { name: appliance.name } : {}),
    ...(typeof appliance.brand === "string" ? { brand: appliance.brand } : {}),
    ...(typeof appliance.type === "string" ? { type: appliance.type } : {}),
    ...(typeof appliance.vib === "string" ? { vib: appliance.vib } : {}),
    ...(typeof appliance.connected === "boolean" ? { connected: appliance.connected } : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HomeConnectProtocolError("Home Connect returned an unexpected response shape.");
  }
  return value as Record<string, unknown>;
}

async function parseJsonObject(response: Response, description: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new HomeConnectProtocolError(`${description} is not valid JSON.`);
  }
  return record(value);
}
