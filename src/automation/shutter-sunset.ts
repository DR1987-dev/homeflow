import { localDate, sunset } from "../astro/sun.js";
import type { DeviceCommand } from "../domain/device.js";
import type { Rule, RuleContext } from "./engine.js";

export const SHUTTER_LEVEL = "shutter_level";
export const ILLUMINANCE = "illuminance_lux";

export interface ShutterSunsetConfig {
  enabled: boolean;
  /** Initial HomeFlow device IDs of the shutters/groups to close; the selection in the HCU configuration overrides it. */
  shutterDeviceIds: readonly string[];
  /** HomeFlow device ID of the weather station. */
  sensorDeviceId: string;
  /** Minutes after sunset when no brightness shift applies (e.g. sensor unavailable). */
  baseOffsetMinutes: number;
  /** Maximum minutes the closing moves earlier (dark/overcast) or later (bright/sunny). */
  earlyMinutes: number;
  lateMinutes: number;
  /** At or below darkLux the closing moves fully earlier; at or above brightLux fully later. */
  darkLux: number;
  brightLux: number;
  smoothingMinutes: number;
  /** HmIP convention: 1.0 is fully closed. */
  closedLevel: number;
  /** Sensor values older than this are ignored and the neutral offset applies. */
  maxSensorAgeMinutes: number;
}

export const DEFAULT_SHUTTER_CONFIG = {
  baseOffsetMinutes: 15,
  earlyMinutes: 60,
  lateMinutes: 30,
  darkLux: 100,
  brightLux: 1000,
  smoothingMinutes: 10,
  closedLevel: 1,
  maxSensorAgeMinutes: 30,
} as const;

/** Offset in minutes relative to sunset + base: negative (earlier) when dark, positive (later) when bright. */
export function brightnessOffsetMinutes(
  lux: number | undefined,
  config: Pick<ShutterSunsetConfig, "earlyMinutes" | "lateMinutes" | "darkLux" | "brightLux">,
): number {
  if (lux === undefined) {
    return 0;
  }
  const { darkLux, brightLux, earlyMinutes, lateMinutes } = config;
  if (lux <= darkLux) {
    return -earlyMinutes;
  }
  if (lux >= brightLux) {
    return lateMinutes;
  }
  const ratio = (lux - darkLux) / (brightLux - darkLux);
  return -earlyMinutes + ratio * (earlyMinutes + lateMinutes);
}

export function closeTime(
  sunsetTime: Date,
  lux: number | undefined,
  config: ShutterSunsetConfig,
): Date {
  const offset = config.baseOffsetMinutes + brightnessOffsetMinutes(lux, config);
  return new Date(sunsetTime.getTime() + offset * 60_000);
}

export function validateShutterConfig(config: ShutterSunsetConfig): void {
  const problems: string[] = [];
  if (!config.sensorDeviceId) problems.push("sensorDeviceId is missing");
  if (!(config.darkLux < config.brightLux)) problems.push("darkLux must be below brightLux");
  if (config.earlyMinutes < 0 || config.lateMinutes < 0) problems.push("early/lateMinutes must be >= 0");
  if (!(config.smoothingMinutes > 0)) problems.push("smoothingMinutes must be positive");
  if (!(config.closedLevel > 0 && config.closedLevel <= 1)) problems.push("closedLevel must be in (0, 1]");
  if (problems.length > 0) {
    throw new Error(`Invalid shutter automation config: ${problems.join("; ")}`);
  }
}

/**
 * Closes shutters once per day at sunset + base offset, shifted by the smoothed outdoor brightness.
 * Since sunset is the anchor and the shift is bounded, the closing time never leaves
 * [sunset + base - early, sunset + base + late].
 */
export function createShutterSunsetRule(
  config: ShutterSunsetConfig,
  getShutterIds: () => readonly string[] = () => config.shutterDeviceIds,
): Rule & {
  currentLux(now: Date): number | undefined;
} {
  validateShutterConfig(config);
  const samples: { at: number; lux: number }[] = [];
  const windowMs = config.smoothingMinutes * 60_000;

  const currentLux = (now: Date): number | undefined => {
    const cutoff = now.getTime() - windowMs;
    const recent = samples.filter((sample) => sample.at >= cutoff);
    if (recent.length === 0) {
      return undefined;
    }
    return recent.reduce((sum, sample) => sum + sample.lux, 0) / recent.length;
  };

  return {
    id: "shutter-sunset",
    oncePerDay: true,
    currentLux,
    observe({ now, state }: RuleContext) {
      const reading = state.get(config.sensorDeviceId).get(ILLUMINANCE);
      if (typeof reading === "number" && Number.isFinite(reading) && state.isAvailable(config.sensorDeviceId)) {
        samples.push({ at: now.getTime(), lux: reading });
      }
      const cutoff = now.getTime() - Math.max(windowMs, config.maxSensorAgeMinutes * 60_000);
      while (samples.length > 0 && samples[0]!.at < cutoff) {
        samples.shift();
      }
    },
    evaluate({ now, state, location }: RuleContext): readonly DeviceCommand[] | undefined {
      if (!location) {
        return undefined;
      }
      const day = localDate(now, location.timeZone);
      const sunsetTime = sunset(day, location.latitude, location.longitude);
      if (!sunsetTime) {
        return undefined;
      }

      const newest = samples[samples.length - 1];
      const fresh = newest !== undefined && now.getTime() - newest.at <= config.maxSensorAgeMinutes * 60_000;
      const target = closeTime(sunsetTime, fresh ? currentLux(now) : undefined, config);
      if (now < target) {
        return undefined;
      }
      return getShutterIds()
        .filter((deviceId) => {
          const level = state.get(deviceId).get(SHUTTER_LEVEL);
          return !(typeof level === "number" && level >= config.closedLevel - 0.01);
        })
        .map((deviceId) => ({
          deviceId,
          capabilityId: SHUTTER_LEVEL,
          value: config.closedLevel,
        }));
    },
  };
}
