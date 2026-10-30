import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AlarmShortcutSettings } from "../src/hcu/alarm-shortcut-settings.js";

describe("AlarmShortcutSettings", () => {
  it("requires a long token, persists it privately, and never returns it in the template", async () => {
    const directory = await mkdtemp(join(tmpdir(), "homeflow-alarm-settings-"));
    const file = join(directory, "settings.json");
    const settings = new AlarmShortcutSettings(file, 8787);

    expect(await settings.update({ alarmShortcutEnabled: true })).toMatchObject({ status: "FAILED" });
    expect(await settings.update({ alarmShortcutToken: "too-short" })).toMatchObject({ status: "FAILED" });
    expect(await settings.update({ alarmShortcutToken: true })).toMatchObject({ status: "FAILED" });
    expect(
      await settings.update({
        alarmShortcutToken: "0123456789abcdef0123456789abcdef0123456789abcdef",
        alarmShortcutEnabled: true,
      }),
    ).toEqual({ status: "APPLIED" });

    expect(settings.token).toBe("0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(JSON.stringify(settings.template())).not.toContain(settings.token);

    const reloaded = new AlarmShortcutSettings(file, 8787);
    await reloaded.load();
    expect(reloaded.token).toBe(settings.token);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ enabled: true, token: settings.token });
  });

  it("keeps a configured token inactive after disabling the endpoint", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "homeflow-alarm-settings-")), "settings.json");
    const settings = new AlarmShortcutSettings(file, 8787);
    await settings.update({
      alarmShortcutToken: "0123456789abcdef0123456789abcdef",
      alarmShortcutEnabled: true,
    });

    expect(await settings.update({ alarmShortcutEnabled: false })).toEqual({ status: "APPLIED" });
    expect(settings.token).toBeUndefined();
  });
});
