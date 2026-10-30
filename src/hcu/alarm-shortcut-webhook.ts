import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { DeviceCommand } from "../domain/device.js";

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1024;
const MAX_RECENT_EVENTS = 2048;
const MAX_REQUESTS_PER_MINUTE = 10;

export interface AlarmShortcutWebhookOptions {
  port: number;
  eventFile: string;
  token: () => string | undefined;
  target: () => DeviceCommand | undefined;
  dispatch: (command: DeviceCommand) => Promise<void>;
  log?: (line: string) => void;
}

/** Authenticated, private-network-only endpoint for one idempotent coffee power-on command. */
export class AlarmShortcutWebhook {
  private server: Server | undefined;
  private readonly eventIds = new Set<string>();
  private requestTimes: number[] = [];

  constructor(private readonly options: AlarmShortcutWebhookOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error("Alarm shortcut port must be an integer from 0 to 65535.");
    }
  }

  get listeningPort(): number | undefined {
    const address = this.server?.address();
    return address && typeof address !== "string" ? address.port : undefined;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.options.eventFile, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("The stored alarm shortcut event cache is invalid.");
    }
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !EVENT_ID.test(id))) {
      throw new Error("The stored alarm shortcut event cache is invalid.");
    }
    for (const id of value.slice(-MAX_RECENT_EVENTS)) this.eventIds.add(id);
  }

  async refresh(): Promise<void> {
    if (!this.options.token()) {
      await this.stop();
      return;
    }
    if (this.server) return;

    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        if (error instanceof RequestError) {
          send(response, error.status, { error: error.code });
          return;
        }
        this.options.log?.(`Alarm shortcut request failed: ${describe(error)}`);
        send(response, 500, { error: "internal_error" });
      });
    });
    this.server = server;
    server.on("error", (error) => {
      this.options.log?.(`Alarm shortcut endpoint error: ${error.message}`);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(this.options.port, "0.0.0.0", () => {
          server.off("error", onError);
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
    this.options.log?.(`Alarm shortcut endpoint listening on port ${this.listeningPort}.`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isPrivateAddress(request.socket.remoteAddress)) {
      send(response, 403, { error: "private_network_only" });
      return;
    }
    const now = Date.now();
    this.requestTimes = this.requestTimes.filter((at) => now - at < 60_000);
    if (this.requestTimes.length >= MAX_REQUESTS_PER_MINUTE) {
      send(response, 429, { error: "rate_limited" });
      return;
    }
    this.requestTimes.push(now);

    if (request.method !== "POST" || request.url !== "/v1/shortcuts/alarm") {
      send(response, 404, { error: "not_found" });
      return;
    }

    const token = this.options.token();
    if (!token || !validBearer(request.headers.authorization, token)) {
      send(response, 401, { error: "unauthorized" });
      return;
    }

    const eventId = await readEventId(request);
    if (this.eventIds.has(eventId)) {
      send(response, 409, { error: "duplicate_event" });
      return;
    }
    const command = this.options.target();
    if (!command) {
      send(response, 409, { error: "coffee_power_switch_not_configured" });
      return;
    }

    this.eventIds.add(eventId);
    let evicted: string | undefined;
    if (this.eventIds.size > MAX_RECENT_EVENTS) {
      evicted = this.eventIds.values().next().value as string | undefined;
      if (evicted) this.eventIds.delete(evicted);
    }
    try {
      await this.saveEvents();
    } catch (error) {
      this.eventIds.delete(eventId);
      if (evicted) this.eventIds.add(evicted);
      throw error;
    }
    try {
      await this.options.dispatch(command);
    } catch (error) {
      this.options.log?.(`Alarm shortcut could not switch on the configured coffee maker: ${describe(error)}`);
      send(response, 502, { error: "device_command_failed", eventConsumed: true });
      return;
    }
    this.options.log?.("Authenticated iPhone alarm event switched on the configured coffee maker.");
    send(response, 200, { ok: true, action: "coffee_power_on" });
  }

  private async saveEvents(): Promise<void> {
    const temporaryFile = `${this.options.eventFile}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.options.eventFile), { recursive: true });
    await writeFile(temporaryFile, JSON.stringify([...this.eventIds]), { mode: 0o600 });
    await chmod(temporaryFile, 0o600);
    await rename(temporaryFile, this.options.eventFile);
  }
}

async function readEventId(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) {
      sendRequestError(413, "body_too_large");
    }
    chunks.push(bytes);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendRequestError(400, "invalid_json");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("eventId" in value) ||
    typeof value.eventId !== "string" ||
    !EVENT_ID.test(value.eventId)
  ) {
    sendRequestError(400, "invalid_event_id");
  }
  return (value as { eventId: string }).eventId;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function sendRequestError(status: number, code: string): never {
  throw new RequestError(status, code);
}

function validBearer(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = header.slice(7);
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  const version = isIP(normalized);
  if (version === 4) {
    const octets = normalized.split(".").map(Number);
    const [first, second] = octets;
    return (
      first === 10 ||
      first === 127 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  if (version === 6) {
    return normalized === "::1" || /^[fc]/.test(normalized) || /^fe[89ab]/.test(normalized);
  }
  return false;
}

function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function describe(error: unknown): string {
  if (error instanceof RequestError) return error.code;
  return error instanceof Error ? error.message : String(error);
}
