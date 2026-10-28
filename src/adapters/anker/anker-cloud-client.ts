import { createCipheriv, createECDH, createHash } from "node:crypto";

// Unofficial Anker Solix cloud API, reverse engineered by https://github.com/thomluther/anker-solix-api (MIT).
// It can change or break at any time without notice.
const SERVER_PUBLIC_KEY_HEX =
  "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";
const SERVERS = {
  eu: "https://ankerpower-api-eu.anker.com",
  com: "https://ankerpower-api.anker.com",
} as const;
const EU_COUNTRIES = new Set([
  "DE", "AT", "CH", "FR", "IT", "ES", "PT", "NL", "BE", "LU", "DK", "SE", "NO", "FI", "PL", "CZ", "SK", "HU", "IE", "GB",
]);

export class AnkerApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "AnkerApiError";
  }
}

export interface AnkerCredentials {
  email: string;
  password: string;
  country: string;
}

export interface AnkerSolarbank {
  sn: string;
  name: string;
  model: string;
  stateOfChargePercent: number | undefined;
  photovoltaicPowerW: number | undefined;
  outputPowerW: number | undefined;
}

export interface AnkerSmartMeter {
  sn: string;
  name: string;
  model: string;
  /** Positive when importing from the grid, negative when exporting. */
  gridPowerW: number | undefined;
  importPowerW: number | undefined;
  exportPowerW: number | undefined;
}

export interface AnkerSnapshot {
  solarbanks: AnkerSolarbank[];
  meters: AnkerSmartMeter[];
}

type Fetch = typeof fetch;

export class AnkerCloudClient {
  private readonly base: string;
  private token: string | undefined;
  private tokenExpiresAt = 0;
  private userId: string | undefined;

  constructor(
    private readonly credentials: AnkerCredentials,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.base = EU_COUNTRIES.has(credentials.country.toUpperCase()) ? SERVERS.eu : SERVERS.com;
  }

  async fetchSnapshot(): Promise<AnkerSnapshot> {
    const sites = await this.post("power_service/v1/site/get_site_list", {});
    const siteIds = asArray(sites.site_list)
      .map((site) => str(asRecord(site).site_id))
      .filter((id): id is string => Boolean(id));

    const banks: AnkerSolarbank[] = [];
    const meters: AnkerSmartMeter[] = [];
    for (const siteId of siteIds) {
      const scene = await this.post("power_service/v1/site/get_scen_info", { site_id: siteId });
      const list = asArray(asRecord(scene.solarbank_info).solarbank_list);
      for (const raw of list) {
        const item = asRecord(raw);
        const sn = str(item.device_sn);
        if (!sn) {
          continue;
        }
        banks.push({
          sn,
          name: str(item.device_name) ?? "Solarbank",
          model: str(item.device_pn) ?? "unknown",
          // Older models report the state of charge as "battery_power" (percent).
          stateOfChargePercent: num(item.battery_soc) ?? num(item.battery_power),
          photovoltaicPowerW: num(item.photovoltaic_power),
          outputPowerW: num(item.output_power),
        });
      }

      // The smart meter values are site wide: grid_info carries the power flow measured by the meter.
      const grid = asRecord(scene.grid_info);
      const meter = asRecord(asArray(grid.grid_list)[0]);
      const meterSn = str(meter.device_sn);
      if (meterSn) {
        const imported = num(grid.grid_to_home_power);
        const exported = num(grid.photovoltaic_to_grid_power);
        meters.push({
          sn: meterSn,
          name: str(meter.device_name) ?? "Smart Meter",
          model: str(meter.device_pn) ?? "unknown",
          gridPowerW: imported === undefined && exported === undefined ? undefined : (imported ?? 0) - (exported ?? 0),
          importPowerW: imported,
          exportPowerW: exported,
        });
      }
    }
    return { solarbanks: banks, meters };
  }

  private async login(): Promise<void> {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const shared = ecdh.computeSecret(Buffer.from(SERVER_PUBLIC_KEY_HEX, "hex"));
    const cipher = createCipheriv("aes-256-cbc", shared, shared.subarray(0, 16));
    const password = Buffer.concat([cipher.update(this.credentials.password, "utf8"), cipher.final()]);

    const data = await this.send("passport/login", {
      ab: this.credentials.country.toUpperCase(),
      client_secret_info: { public_key: ecdh.getPublicKey("hex") },
      enc: 0,
      email: this.credentials.email,
      password: password.toString("base64"),
      time_zone: -new Date().getTimezoneOffset() * 60_000,
      transaction: String(this.now()),
    });

    const token = str(data.auth_token);
    const userId = str(data.user_id);
    if (!token || !userId) {
      throw new AnkerApiError("Login response contained no token.");
    }
    this.token = token;
    this.userId = userId;
    const expires = num(data.token_expires_at);
    this.tokenExpiresAt = expires ? expires * 1000 : this.now() + 3_600_000;
  }

  private async post(endpoint: string, body: object): Promise<Record<string, unknown>> {
    if (!this.token || this.now() > this.tokenExpiresAt - 60_000) {
      await this.login();
    }
    try {
      return await this.send(endpoint, body);
    } catch (error) {
      if (error instanceof AnkerApiError && error.code === 401) {
        this.token = undefined;
        await this.login();
        return this.send(endpoint, body);
      }
      throw error;
    }
  }

  private async send(endpoint: string, body: object): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "model-type": "DESKTOP",
      "app-name": "anker_power",
      "os-type": "android",
      country: this.credentials.country.toUpperCase(),
    };
    if (this.token && this.userId) {
      headers["x-auth-token"] = this.token;
      headers.gtoken = createHash("md5").update(this.userId).digest("hex");
    }

    const response = await this.fetchImpl(`${this.base}/${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = asRecord(await response.json().catch(() => ({})));
    const code = num(payload.code) ?? response.status;
    if (code !== 0) {
      // The message may echo account data, so only the code and the server text are exposed.
      throw new AnkerApiError(`Anker API error ${code}: ${str(payload.msg) ?? "no message"}`, code);
    }
    return asRecord(payload.data);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}
