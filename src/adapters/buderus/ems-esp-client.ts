export type EmsEspValue = boolean | number | string;

export interface EmsEspDeviceData {
  device: "boiler" | "thermostat" | "mixer";
  values: Readonly<Record<string, EmsEspValue>>;
}

export class EmsEspApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "EmsEspApiError";
  }
}

export class EmsEspClient {
  private readonly baseUrl: URL;

  constructor(
    gatewayUrl: string,
    private readonly accessToken?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.baseUrl = new URL(normalizeGatewayUrl(gatewayUrl));
  }

  async fetchDevice(device: EmsEspDeviceData["device"]): Promise<EmsEspDeviceData | undefined> {
    const url = new URL(`/api/${device}/values`, this.baseUrl);
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.accessToken) {
      headers.authorization = this.accessToken;
    }
    let response: Response;
    try {
      response = await this.fetcher(url, { headers, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      throw new EmsEspApiError(`EMS-ESP ${device} ist nicht erreichbar: ${describe(error)}`);
    }
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new EmsEspApiError(`EMS-ESP ${device} API antwortete mit HTTP ${response.status}.`, response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EmsEspApiError(`EMS-ESP ${device} API lieferte kein gültiges JSON.`);
    }
    return { device, values: extractValues(payload) };
  }

  async setThermostatHc2Setpoint(value: number): Promise<void> {
    const url = new URL("/api/thermostat/hc2/seltemp", this.baseUrl);
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (this.accessToken) {
      headers.authorization = this.accessToken;
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ data: value }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new EmsEspApiError(`EMS-ESP Heizkreis 2 konnte nicht gesetzt werden: ${describe(error)}`);
    }
    if (!response.ok) {
      const message =
        response.status === 401 || response.status === 403
          ? "EMS-ESP hat den Schreibzugriff abgelehnt; API-Token und EMS-ESP-Berechtigung prüfen."
          : `EMS-ESP Heizkreis 2 API antwortete mit HTTP ${response.status}.`;
      throw new EmsEspApiError(message, response.status);
    }
  }
}

export function normalizeGatewayUrl(input: string): string {
  let value = input.trim();
  if (!value) {
    throw new EmsEspApiError("Bitte die Adresse des EMS-ESP-Gateways eintragen.");
  }
  while (/^https?:\/\/https?:\/\//i.test(value)) {
    value = value.replace(/^https?:\/\//i, "");
  }
  if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmsEspApiError("Die EMS-ESP-Adresse ist keine gültige URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new EmsEspApiError("Die EMS-ESP-Adresse muss eine HTTP(S)-Adresse ohne Zugangsdaten sein.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function extractValues(payload: unknown): Record<string, EmsEspValue> {
  const values: Record<string, EmsEspValue> = {};
  const visit = (value: unknown, prefix = ""): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isRecord(entry)) {
          const key = text(entry.shortName) ?? text(entry.id) ?? text(entry.name) ?? text(entry.key);
          if (key) {
            const candidate = entry.value ?? entry.data;
            if (isValue(candidate)) {
              values[normalizeKey(prefix ? `${prefix}_${key}` : key)] = candidate;
            } else {
              visit(entry, prefix ? `${prefix}_${key}` : key);
            }
          } else {
            visit(entry, prefix);
          }
        }
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (isValue(value.value)) {
      if (prefix) {
        values[normalizeKey(prefix)] = value.value;
      }
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (["id", "name", "type", "unit", "units", "brand", "product", "version"].includes(key.toLowerCase())) {
        continue;
      }
      if (isValue(nested)) {
        values[normalizeKey(prefix ? `${prefix}_${key}` : key)] = nested;
      } else {
        visit(nested, prefix ? `${prefix}_${key}` : key);
      }
    }
  };
  visit(payload);
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValue(value: unknown): value is EmsEspValue {
  return typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
