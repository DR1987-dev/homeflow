import type {
  CapabilityReading,
  DeviceCommand,
  DeviceDefinition,
  DeviceKind,
} from "../../domain/device.js";
import type { DeviceAdapter } from "../device-adapter.js";
import { EmsEspClient, type EmsEspDeviceData, type EmsEspValue } from "./ems-esp-client.js";

export const EMS_ESP_ADAPTER_ID = "buderus-ems-esp";
export const RC35_HC2_SETPOINT_MIN_C = 5;
export const RC35_HC2_SETPOINT_MAX_C = 25;

const DEVICE_TYPES = ["boiler", "thermostat", "mixer"] as const;
type EmsEspDeviceType = (typeof DEVICE_TYPES)[number];

const temperatureSensors = [
  { id: "emsesp:sensor:outdoor", source: "boiler", field: "outdoortemp", name: "Buderus Außentemperatur" },
  { id: "emsesp:sensor:hot-water", source: "boiler", field: "dhw_curtemp", name: "Buderus Warmwasser Ist" },
  { id: "emsesp:sensor:hc2-flow", source: "mixer", field: "hc2_flowtemphc", name: "Buderus Heizkreis 2 Vorlauf Ist" },
] as const;

export class EmsEspAdapter implements DeviceAdapter {
  readonly id = EMS_ESP_ADAPTER_ID;
  private known = new Map<string, EmsEspDeviceData>();
  private readonly cache = new Map<EmsEspDeviceType, { at: number; data: EmsEspDeviceData | undefined }>();

  constructor(
    private readonly client: EmsEspClient,
    private readonly setpointControlHc2 = false,
    private readonly now: () => number = Date.now,
  ) {}

  async discover(): Promise<readonly DeviceDefinition[]> {
    const definitions: DeviceDefinition[] = [];
    const known = new Map<string, EmsEspDeviceData>();
    for (const type of DEVICE_TYPES) {
      const data = await this.fetchDevice(type);
      if (!data) {
        continue;
      }
      known.set(deviceId(type), data);
      definitions.push(toDefinition(type, data.values, this.setpointControlHc2));
      for (const sensor of temperatureSensors) {
        if (sensor.source === type && typeof data.values[sensor.field] === "number") {
          definitions.push({
            id: sensor.id,
            adapterId: this.id,
            manufacturer: "Buderus",
            model: "EMS-ESP Temperatursensor",
            name: sensor.name,
            kind: "climate-sensor",
            capabilities: [{
              id: "actual_temperature_c",
              label: sensor.name,
              type: "number",
              unit: "°C",
              readable: true,
              writable: false,
            }],
          });
        }
      }
    }
    if (definitions.length === 0) {
      throw new Error("EMS-ESP meldet weder einen Heizkessel noch einen Thermostat.");
    }
    this.known = known;
    return definitions;
  }

  async readState(id: string): Promise<readonly CapabilityReading[]> {
    const sensor = temperatureSensors.find((candidate) => candidate.id === id);
    if (sensor) {
      if (!this.known.has(deviceId(sensor.source))) {
        throw new Error(`EMS-ESP-Gerät "${sensor.source}" wurde nicht entdeckt.`);
      }
      const data = await this.fetchDevice(sensor.source);
      const value = data?.values[sensor.field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < -50 || value > 60) {
        throw new Error(`EMS-ESP-Messwert "${sensor.field}" fehlt oder liegt außerhalb des HCU-Bereichs von -50 bis 60 °C.`);
      }
      return [{ capabilityId: "actual_temperature_c", value, observedAt: new Date().toISOString() }];
    }
    const type = deviceType(id);
    if (!type || !this.known.has(id)) {
      throw new Error(`EMS-ESP-Gerät "${id}" wurde nicht entdeckt.`);
    }
    const data = await this.fetchDevice(type);
    if (!data) {
      throw new Error(`EMS-ESP-Gerät "${type}" ist nicht mehr verfügbar.`);
    }
    if (
      type === "thermostat" &&
      isTemperature(this.known.get(id)?.values.hc2_currtemp) &&
      !isTemperature(data.values.hc2_currtemp)
    ) {
      throw new Error("EMS-ESP RC35-Isttemperatur fehlt oder liegt außerhalb des HCU-Bereichs von -50 bis 60 °C.");
    }
    this.known.set(id, data);
    const observedAt = new Date().toISOString();
    const setpointField = type === "thermostat" ? findHc2SetpointField(data.values) : undefined;
    return Object.entries(data.values).map(([field, value]) => ({
      capabilityId:
        type === "thermostat" && field === setpointField
          ? "target_temperature_c"
          : type === "thermostat" && field === "hc2_currtemp" && isTemperature(value)
            ? "actual_temperature_c"
            : capabilityId(type, field),
      value,
      observedAt,
    }));
  }

  async execute(command: DeviceCommand): Promise<void> {
    if (
      !this.setpointControlHc2 ||
      command.deviceId !== deviceId("thermostat") ||
      command.capabilityId !== "target_temperature_c" ||
      typeof command.value !== "number" ||
      command.value < RC35_HC2_SETPOINT_MIN_C ||
      command.value > RC35_HC2_SETPOINT_MAX_C
    ) {
      throw new Error("Nur die freigegebene RC35-Solltemperatur in Heizkreis 2 (5 bis 25 °C) kann gesetzt werden.");
    }
    await this.client.setThermostatHc2Setpoint(command.value);
  }

  private async fetchDevice(type: EmsEspDeviceType): Promise<EmsEspDeviceData | undefined> {
    const cached = this.cache.get(type);
    if (cached && this.now() - cached.at < 10_000) {
      return cached.data;
    }
    const data = await this.client.fetchDevice(type);
    this.cache.set(type, { at: this.now(), data });
    return data;
  }
}

function toDefinition(
  type: EmsEspDeviceType,
  values: Readonly<Record<string, EmsEspValue>>,
  setpointControlHc2: boolean,
): DeviceDefinition {
  const setpointField = type === "thermostat" ? findHc2SetpointField(values) : undefined;
  const kind: DeviceKind | undefined = setpointField ? "thermostat" : undefined;
  return {
    id: deviceId(type),
    adapterId: EMS_ESP_ADAPTER_ID,
    manufacturer: "Buderus",
    model: type === "boiler" ? "EMS-ESP Heizkessel" : type === "mixer" ? "EMS-ESP Mischer" : "EMS-ESP Thermostat",
    name: type === "boiler" ? "Buderus Heizkessel" : type === "mixer" ? "Buderus Mischer" : "Buderus Heizungsregler",
    ...(kind && { kind }),
    capabilities: Object.entries(values).map(([field, value]) => {
      const mappedSetpoint = type === "thermostat" && field === setpointField;
      const mappedActual = type === "thermostat" && field === "hc2_currtemp" && isTemperature(value);
      return {
        id: mappedSetpoint ? "target_temperature_c" : mappedActual ? "actual_temperature_c" : capabilityId(type, field),
        label: mappedSetpoint ? "Solltemperatur" : mappedActual ? "Raumtemperatur RC35" : field,
        type: valueType(value),
        readable: true,
        writable: mappedSetpoint && setpointControlHc2,
        supportStatus: "SUPPORTED",
        ...(mappedSetpoint && {
          min: RC35_HC2_SETPOINT_MIN_C,
          max: RC35_HC2_SETPOINT_MAX_C,
        }),
        ...(mappedSetpoint || mappedActual ? { unit: "°C" } : {}),
      };
    }),
  };
}

function findHc2SetpointField(values: Readonly<Record<string, EmsEspValue>>): string | undefined {
  return Object.keys(values).find((field) =>
    /^hc2_(seltemp|setpoint|set_temp|target_temperature|targettemp)$/i.test(field),
  );
}

function capabilityId(type: EmsEspDeviceType, field: string): string {
  return `emsesp_${type}_${field}`;
}

function deviceId(type: EmsEspDeviceType): string {
  return `emsesp:${type}`;
}

function deviceType(id: string): EmsEspDeviceType | undefined {
  return DEVICE_TYPES.find((type) => id === deviceId(type));
}

function valueType(value: EmsEspValue): "boolean" | "number" | "string" {
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return "number";
  }
  return "string";
}

function isTemperature(value: EmsEspValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -50 && value <= 60;
}
