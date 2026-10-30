import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlarmShortcutWebhook } from "../src/hcu/alarm-shortcut-webhook.js";
import type { DeviceCommand } from "../src/domain/device.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const COMMAND: DeviceCommand = { deviceId: "home-connect-ctl:coffee:power", capabilityId: "on", value: true };
const EVENT_ID = "20261030-174625-58392017";

describe("AlarmShortcutWebhook", () => {
  const active: AlarmShortcutWebhook[] = [];

  afterEach(async () => {
    await Promise.all(active.splice(0).map((webhook) => webhook.stop()));
  });

  async function start(options: {
    token?: string;
    target?: DeviceCommand | null;
    dispatch?: (command: DeviceCommand) => Promise<void>;
  } = {}) {
    const eventFile = join(await mkdtemp(join(tmpdir(), "homeflow-alarm-webhook-")), "events.json");
    const webhook = new AlarmShortcutWebhook({
      port: 0,
      eventFile,
      token: () => options.token ?? TOKEN,
      target: () => (options.target === null ? undefined : options.target ?? COMMAND),
      dispatch: options.dispatch ?? vi.fn(async () => undefined),
    });
    active.push(webhook);
    await webhook.load();
    await webhook.refresh();
    const url = `http://127.0.0.1:${webhook.listeningPort}/v1/shortcuts/alarm`;
    return { webhook, url, eventFile };
  }

  const send = (url: string, eventId = EVENT_ID, token = TOKEN) =>
    fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId }),
    });

  it("dispatches only the configured command and rejects duplicate event IDs across restarts", async () => {
    const dispatch = vi.fn(async () => undefined);
    const first = await start({ dispatch });

    const response = await send(first.url);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, action: "coffee_power_on" });
    expect(dispatch).toHaveBeenCalledWith(COMMAND);

    const duplicate = await send(first.url);
    expect(duplicate.status).toBe(409);

    await first.webhook.stop();
    const restarted = new AlarmShortcutWebhook({
      port: 0,
      eventFile: first.eventFile,
      token: () => TOKEN,
      target: () => COMMAND,
      dispatch,
    });
    active.push(restarted);
    await restarted.load();
    await restarted.refresh();

    const replay = await send(`http://127.0.0.1:${restarted.listeningPort}/v1/shortcuts/alarm`);
    expect(replay.status).toBe(409);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects missing credentials, invalid event IDs, and missing appliance authorization", async () => {
    const dispatch = vi.fn(async () => undefined);
    const { url } = await start({ dispatch });

    expect((await send(url, EVENT_ID, "wrong-token")).status).toBe(401);
    expect((await send(url, "")).status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();

    const noTarget = await start({ target: null });
    const response = await fetch(noTarget.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "fd337673-7655-48ea-838d-36ac886af910" }),
    });
    expect(response.status).toBe(409);
  });

  it("returns an explicit failure when the Home Connect action fails", async () => {
    const { url } = await start({
      dispatch: async () => {
        throw new Error("remote start unavailable");
      },
    });

    const response = await send(url);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "device_command_failed", eventConsumed: true });
  });
});
