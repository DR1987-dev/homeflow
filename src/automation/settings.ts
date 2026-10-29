import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DeviceDefinition } from "../domain/device.js";
import type { GeoLocation } from "./engine.js";
import { ILLUMINANCE, validateShutterConfig, type ShutterSunsetConfig } from "./shutter-sunset.js";

const NUMERIC = {
  baseOffsetMinutes: { label: "Minuten nach Sonnenuntergang (Basis)", min: -180, max: 180 },
  earlyMinutes: { label: "Max. Minuten früher bei Dunkelheit/Bewölkung", min: 0, max: 240 },
  lateMinutes: { label: "Max. Minuten später bei Helligkeit", min: 0, max: 240 },
  darkLux: { label: "Dunkel ab (Lux, darunter maximal früher)", min: 0, max: 100000 },
  brightLux: { label: "Hell ab (Lux, darüber maximal später)", min: 1, max: 200000 },
  smoothingMinutes: { label: "Helligkeit mitteln über (Minuten)", min: 1, max: 120 },
} as const;

type NumericKey = keyof typeof NUMERIC;
const KEYS = Object.keys(NUMERIC) as NumericKey[];

export const SETTING_PREFIX = "setting:";
export const SENSOR_KEY = "setting:sensor";
export const ENABLED_KEY = "setting:enabled";
export const isSettingKey = (key: string) => key.startsWith(SETTING_PREFIX);

export interface StatusSource {
  currentLux(now: Date): number | undefined;
  plannedCloseTime(context: { now: Date; location: GeoLocation | undefined }): Date | undefined;
}

export class SettingsError extends Error {}

/** Editable automation settings shown on the HCUweb configuration page. Mutates `config` in place so the rule sees changes at once. */
export class ShutterSettings {
  constructor(
    private readonly options: {
      file: string;
      config: ShutterSunsetConfig;
      candidates: () => readonly DeviceDefinition[];
      isEnabled: () => boolean;
      /** True once the rule completed for the local day of the given instant. */
      doneToday: (now: Date) => boolean;
      setEnabled: (enabled: boolean) => Promise<void>;
      status: () => StatusSource | undefined;
      location: () => GeoLocation | undefined;
      now?: () => Date;
    },
  ) {}

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.options.file, "utf8")) as Record<string, unknown>;
      const next = { ...this.options.config };
      for (const key of KEYS) {
        if (typeof saved[key] === "number") next[key] = saved[key];
      }
      if (typeof saved.sensorDeviceId === "string") next.sensorDeviceId = saved.sensorDeviceId;
      validateShutterConfig(next);
      Object.assign(this.options.config, next);
    } catch {
      // No (valid) saved settings: the initial configuration applies.
    }
  }

  /** The chosen sensor, or the only illuminance sensor if there is exactly one. */
  sensorId(): string | undefined {
    if (this.options.config.sensorDeviceId) return this.options.config.sensorDeviceId;
    const sensors = this.sensors();
    return sensors.length === 1 ? sensors[0]!.id : undefined;
  }

  private sensors(): DeviceDefinition[] {
    return this.options.candidates().filter((d) => d.capabilities.some((c) => c.id === ILLUMINANCE));
  }

  private sensorLabel(device: DeviceDefinition) {
    return `${device.name} [${device.id}]`;
  }

  template() {
    const { config } = this.options;
    const now = (this.options.now ?? (() => new Date()))();
    const status = this.options.status();
    const lux = status?.currentLux(now);
    const location = this.options.location();
    const format = (date: Date | undefined) =>
      date
        ? new Intl.DateTimeFormat("de-DE", { timeZone: location?.timeZone ?? "UTC", hour: "2-digit", minute: "2-digit" }).format(date)
        : undefined;
    const done = this.options.doneToday(now);
    const planned = format(status?.plannedCloseTime({ now: done ? new Date(now.getTime() + 86_400_000) : now, location }));
    const time = !planned
      ? "unbekannt (Standort fehlt oder keine Dämmerung)"
      : done
        ? `heute erledigt; morgen ca. ${planned} Uhr (ohne Helligkeitsverschiebung)`
        : `${planned} Uhr`;

    const sensors = this.sensors();
    const current = sensors.find((d) => d.id === this.sensorId());
    const properties: Record<string, unknown> = {
      [ENABLED_KEY]: {
        dataType: "BOOLEAN",
        friendlyName: "Automatik aktiv",
        groupId: "automation",
        order: 1,
        currentValue: String(this.options.isEnabled()),
      },
      "status:close": {
        dataType: "READONLY",
        friendlyName: "Geplante Schließzeit",
        groupId: "automation",
        order: 2,
        currentValue: time,
      },
      "status:lux": {
        dataType: "READONLY",
        friendlyName: "Aktuelle Helligkeit (gemittelt)",
        groupId: "automation",
        order: 3,
        currentValue: lux === undefined ? "kein aktueller Messwert" : `${Math.round(lux)} lx`,
      },
    };
    if (sensors.length > 0) {
      properties[SENSOR_KEY] = {
        dataType: "ENUM",
        friendlyName: "Helligkeitssensor",
        groupId: "automation",
        order: 4,
        values: sensors.map((d) => this.sensorLabel(d)),
        ...(current && { currentValue: this.sensorLabel(current) }),
      };
    }
    KEYS.forEach((key, index) => {
      const spec = NUMERIC[key];
      properties[`${SETTING_PREFIX}${key}`] = {
        dataType: "INTEGER",
        friendlyName: spec.label,
        groupId: "automation",
        order: 10 + index,
        minimum: spec.min,
        maximum: spec.max,
        currentValue: String(Math.round(config[key])),
      };
    });

    return {
      groups: {
        automation: {
          friendlyName: "Rollladen-Automatik: Einstellungen",
          description:
            "Schließzeit = Sonnenuntergang + Basis, verschoben nach Helligkeit: bei Dunkelheit bis zu „früher“ Minuten eher, bei Helligkeit bis zu „später“ Minuten später.",
          order: 1,
        },
      },
      properties,
    };
  }

  /** Validates and applies all submitted settings atomically; throws SettingsError with a user-facing message. */
  async update(properties: Record<string, unknown>): Promise<void> {
    const next = { ...this.options.config };
    for (const key of KEYS) {
      const raw = properties[`${SETTING_PREFIX}${key}`];
      if (raw === undefined || raw === "") continue;
      const value = Number(raw);
      const spec = NUMERIC[key];
      if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
        throw new SettingsError(`„${spec.label}“ muss zwischen ${spec.min} und ${spec.max} liegen.`);
      }
      next[key] = Math.round(value);
    }
    if (!(next.darkLux < next.brightLux)) {
      throw new SettingsError("„Dunkel ab“ muss kleiner als „Hell ab“ sein.");
    }

    const sensorRaw = properties[SENSOR_KEY];
    if (typeof sensorRaw === "string" && sensorRaw !== "") {
      const match = this.sensors().find((d) => this.sensorLabel(d) === sensorRaw);
      if (!match) throw new SettingsError("Unbekannter Helligkeitssensor.");
      next.sensorDeviceId = match.id;
    }
    validateShutterConfig(next);

    const enabledRaw = properties[ENABLED_KEY];
    Object.assign(this.options.config, next);
    await mkdir(dirname(this.options.file), { recursive: true });
    await writeFile(
      this.options.file,
      JSON.stringify({
        ...Object.fromEntries(KEYS.map((key) => [key, next[key]])),
        sensorDeviceId: next.sensorDeviceId,
      }),
      "utf8",
    );
    if (typeof enabledRaw === "boolean") {
      await this.options.setEnabled(enabledRaw);
    }
  }
}
