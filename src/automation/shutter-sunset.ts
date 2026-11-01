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
  /** Minutes after sunset at which to close when no fresh brightness value exists (clamped to the window). */
  baseOffsetMinutes: number;
  /** The window is [sunset - earlyMinutes, sunset + lateMinutes]; nothing closes before it opens. */
  earlyMinutes: number;
  /** Latest closing time, as minutes after sunset, even if it is still bright. */
  lateMinutes: number;
  /** Within the window the shutters close as soon as the smoothed brightness is at or below this value. */
  darkLux: number;
  smoothingMinutes: number;
  /** HmIP convention: 1.0 is fully closed. */
  closedLevel: number;
  /** Sensor values older than this are ignored and the neutral offset applies. */
  maxSensorAgeMinutes: number;
}

export const DEFAULT_SHUTTER_CONFIG = {
  baseOffsetMinutes: 15,
  earlyMinutes: 60,
  lateMinutes: 45,
  darkLux: 40,
  smoothingMinutes: 10,
  closedLevel: 1,
  maxSensorAgeMinutes: 30,
} as const;

export interface CloseWindow {
  earliest: Date;
  latest: Date;
  /** Closing time without brightness data. */
  fallback: Date;
}

/**
 * Closing depends on the physical darkness (absolute lux), not on a fixed offset, so it follows the
 * season by itself: a clear evening reaches the threshold shortly after sunset in any month, an overcast
 * or rainy one earlier. The window bounds the result in both directions.
 */
export function closeWindow(sunsetTime: Date, config: ShutterSunsetConfig): CloseWindow {
  const at = (minutes: number) => new Date(sunsetTime.getTime() + minutes * 60_000);
  const clamped = Math.min(Math.max(config.baseOffsetMinutes, -config.earlyMinutes), config.lateMinutes);
  return { earliest: at(-config.earlyMinutes), latest: at(config.lateMinutes), fallback: at(clamped) };
}

/** True when the shutters should close now. `lux` is undefined without a fresh sensor value. */
export function isCloseDue(
  now: Date,
  window: CloseWindow,
  lux: number | undefined,
  config: Pick<ShutterSunsetConfig, "darkLux">,
): boolean {
  if (now < window.earliest) {
    return false;
  }
  if (lux === undefined) {
    return now >= window.fallback;
  }
  return lux <= config.darkLux || now >= window.latest;
}

export function validateShutterConfig(config: ShutterSunsetConfig): void {
  const problems: string[] = [];
  if (!(config.darkLux >= 0)) problems.push("darkLux must be >= 0");
  if (config.earlyMinutes < 0 || config.lateMinutes < 0) problems.push("early/lateMinutes must be >= 0");
  if (!(config.baseOffsetMinutes >= -180 && config.baseOffsetMinutes <= 180)) problems.push("baseOffsetMinutes must be within ±180");
  if (!(config.smoothingMinutes > 0)) problems.push("smoothingMinutes must be positive");
  if (!(config.closedLevel > 0 && config.closedLevel <= 1)) problems.push("closedLevel must be in (0, 1]");
  if (problems.length > 0) {
    throw new Error(`Invalid shutter automation config: ${problems.join("; ")}`);
  }
}

/**
 * Closes shutters once per day: within [sunset - early, sunset + late] as soon as the smoothed outdoor
 * brightness drops to darkLux, at the latest at the end of the window.
 */
export function createShutterSunsetRule(
  config: ShutterSunsetConfig,
  getShutterIds: () => readonly string[] = () => config.shutterDeviceIds,
  getSensorId: () => string | undefined = () => config.sensorDeviceId,
): Rule & {
  currentLux(now: Date): number | undefined;
  closeWindowFor(context: Pick<RuleContext, "now" | "location">): CloseWindow | undefined;
} {
  validateShutterConfig(config);
  const samples: { at: number; lux: number }[] = [];
  const windowMs = () => config.smoothingMinutes * 60_000;

  const currentLux = (now: Date): number | undefined => {
    const cutoff = now.getTime() - windowMs();
    const recent = samples.filter((sample) => sample.at >= cutoff);
    if (recent.length === 0) {
      return undefined;
    }
    return recent.reduce((sum, sample) => sum + sample.lux, 0) / recent.length;
  };

  const closeWindowFor = ({ now, location }: Pick<RuleContext, "now" | "location">): CloseWindow | undefined => {
    if (!location) {
      return undefined;
    }
    const sunsetTime = sunset(localDate(now, location.timeZone), location.latitude, location.longitude);
    return sunsetTime ? closeWindow(sunsetTime, config) : undefined;
  };

  const freshLux = (now: Date): number | undefined => {
    const newest = samples[samples.length - 1];
    const fresh = newest !== undefined && now.getTime() - newest.at <= config.maxSensorAgeMinutes * 60_000;
    return fresh ? currentLux(now) : undefined;
  };

  return {
    id: "shutter-sunset",
    oncePerDay: true,
    currentLux,
    closeWindowFor,
    observe({ now, state }: RuleContext) {
      const sensorId = getSensorId();
      const reading = sensorId ? state.get(sensorId).get(ILLUMINANCE) : undefined;
      if (sensorId && typeof reading === "number" && Number.isFinite(reading) && state.isAvailable(sensorId)) {
        samples.push({ at: now.getTime(), lux: reading });
      }
      const cutoff = now.getTime() - Math.max(windowMs(), config.maxSensorAgeMinutes * 60_000);
      while (samples.length > 0 && samples[0]!.at < cutoff) {
        samples.shift();
      }
    },
    evaluate({ now, state, location }: RuleContext): readonly DeviceCommand[] | undefined {
      const window = closeWindowFor({ now, location });
      if (!window || !isCloseDue(now, window, freshLux(now), config)) {
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
