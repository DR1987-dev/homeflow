import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  parsePluginMessage,
  pluginStateResponse,
  replyTo,
  type PluginMessage,
} from "./connect-api.js";

export interface HcuConnectOptions {
  pluginId: string;
  host: string;
  token: string;
  systemEvents?: boolean;
  /** The HCU serves a self-signed certificate, so validation is off unless a trust store is supplied. */
  rejectUnauthorized?: boolean;
  reconnectDelayMs?: number;
  onMessage?: (message: PluginMessage) => PluginMessage | undefined | Promise<PluginMessage | undefined>;
  log?: (line: string) => void;
}

export class HcuConnectClient {
  private socket: WebSocket | undefined;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: HcuConnectOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private connect(): void {
    const { pluginId, host, token, systemEvents, rejectUnauthorized, log } = this.options;
    const socket = new WebSocket(`wss://${host}:9001`, {
      rejectUnauthorized: rejectUnauthorized ?? false,
      headers: {
        authtoken: token.trim(),
        "plugin-id": pluginId,
        ...(systemEvents ? { "hmip-system-events": "true" } : {}),
      },
    });
    this.socket = socket;

    socket.on("open", () => {
      log?.("Connected to HCU Connect API");
      this.send(pluginStateResponse(pluginId, randomUUID()));
    });
    socket.on("message", (data) => void this.handle(data.toString()));
    socket.on("error", (error) => log?.(`WebSocket error: ${error.message}`));
    socket.on("close", () => {
      if (this.stopped) {
        return;
      }
      this.reconnectTimer = setTimeout(
        () => this.connect(),
        this.options.reconnectDelayMs ?? 5000,
      );
    });
  }

  private async handle(raw: string): Promise<void> {
    try {
      const message = parsePluginMessage(raw);
      const reply =
        replyTo(this.options.pluginId, message) ?? (await this.options.onMessage?.(message));
      if (reply) {
        this.send(reply);
      }
    } catch (error) {
      this.options.log?.(error instanceof Error ? error.message : String(error));
    }
  }

  private send(message: PluginMessage): void {
    this.socket?.send(JSON.stringify(message));
  }
}
