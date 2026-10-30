import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface StoredAlarmShortcutSettings {
  enabled: boolean;
  token?: string;
}

export class AlarmShortcutSettings {
  private settings: StoredAlarmShortcutSettings = { enabled: false };

  constructor(
    private readonly file: string,
    private readonly port: number,
  ) {}

  get token(): string | undefined {
    return this.settings.enabled ? this.settings.token : undefined;
  }

  template() {
    return {
      groups: {
        alarmShortcut: {
          friendlyName: "iPhone-Wecker (Kurzbefehle)",
          description: `Erlaubt einen authentifizierten Wecker-Aufruf im Heimnetz. HomeFlow-Port: ${this.port}.`,
          order: 7,
        },
      },
      properties: {
        alarmShortcutEnabled: {
          dataType: "BOOLEAN",
          friendlyName: "Wecker-Aufruf erlauben",
          groupId: "alarmShortcut",
          order: 1,
          currentValue: String(this.settings.enabled),
        },
        alarmShortcutToken: {
          dataType: "PASSWORD",
          friendlyName: "Geheimer Kurzbefehle-Token (mindestens 32 Zeichen)",
          groupId: "alarmShortcut",
          required: false,
          order: 2,
        },
      },
    };
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Die gespeicherten Kurzbefehle-Einstellungen sind ungültig.");
    }
    if (!isRecord(value) || typeof value.enabled !== "boolean") {
      throw new Error("Die gespeicherten Kurzbefehle-Einstellungen sind ungültig.");
    }
    if (value.token !== undefined && (typeof value.token !== "string" || value.token.length < 32)) {
      throw new Error("Der gespeicherte Kurzbefehle-Token ist ungültig.");
    }
    this.settings = {
      enabled: value.enabled,
      ...(typeof value.token === "string" && { token: value.token }),
    };
  }

  async update(properties: Record<string, unknown>): Promise<{ status: "APPLIED" | "FAILED"; message?: string }> {
    if (!("alarmShortcutEnabled" in properties || "alarmShortcutToken" in properties)) {
      return { status: "APPLIED" };
    }

    const next = { ...this.settings };
    if ("alarmShortcutEnabled" in properties) {
      if (typeof properties.alarmShortcutEnabled !== "boolean") {
        return { status: "FAILED", message: "Die Wecker-Aufruf-Einstellung muss aktiviert oder deaktiviert sein." };
      }
      next.enabled = properties.alarmShortcutEnabled;
    }
    if ("alarmShortcutToken" in properties) {
      if (typeof properties.alarmShortcutToken !== "string") {
        return { status: "FAILED", message: "Der Kurzbefehle-Token muss Text sein." };
      }
      const token = properties.alarmShortcutToken.trim();
      if (token && token.length < 32) {
        return { status: "FAILED", message: "Der Kurzbefehle-Token muss mindestens 32 Zeichen lang sein." };
      }
      if (token) next.token = token;
    }
    if (next.enabled && !next.token) {
      return { status: "FAILED", message: "Zum Aktivieren zuerst einen Kurzbefehle-Token mit mindestens 32 Zeichen eintragen." };
    }

    try {
      await this.save(next);
      this.settings = next;
      return { status: "APPLIED" };
    } catch (error) {
      return {
        status: "FAILED",
        message: `Die Kurzbefehle-Einstellungen konnten nicht gespeichert werden: ${describe(error)}`,
      };
    }
  }

  private async save(settings: StoredAlarmShortcutSettings): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(settings), { mode: 0o600 });
    await chmod(this.file, 0o600);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
