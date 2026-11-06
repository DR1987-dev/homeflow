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

const DEVICE_TYPES = ["boiler", "thermostat"] as const;
type EmsEspDeviceType = (typeof DEVICE_TYPES)[number];

export class EmsEspAdapter implements DeviceAdapter {
  readonly id = EMS_ESP_ADAPTER_ID;
  private known = new Map<string, EmsEspDeviceData>();

  constructor(
    private readonly client: EmsEspClient,
    private readonly setpointControlHc2 = false,
  ) {}

  async discover(): Promise<readonly DeviceDefinition[]> {
    const definitions: DeviceDefinition[] = [];
    const known = new Map<string, EmsEspDeviceData>();
    for (const type of DEVICE_TYPES) {
      const data = await this.client.fetchDevice(type);
      if (!data) {
        continue;
      }
      known.set(deviceId(type), data);
      definitions.push(toDefinition(type, data.values, this.setpointControlHc2));
    }
    if (definitions.length === 0) {
      throw new Error("EMS-ESP meldet weder einen Heizkessel noch einen Thermostat.");
    }
    this.known = known;
    return definitions;
  }

  async readState(id: string): Promise<readonly CapabilityReading[]> {
    const type = deviceType(id);
    if (!type || !this.known.has(id)) {
      throw new Error(`EMS-ESP-Gerät "${id}" wurde nicht entdeckt.`);
    }
    const data = await this.client.fetchDevice(type);
    if (!data) {
      throw new Error(`EMS-ESP-Gerät "${type}" ist nicht mehr verfügbar.`);
    }
    this.known.set(id, data);
    const observedAt = new Date().toISOString();
    const setpointField = type === "thermostat" ? findHc2SetpointField(data.values) : undefined;
    return Object.entries(data.values).map(([field, value]) => ({
      capabilityId:
        type === "thermostat" && field === setpointField
          ? "target_temperature_c"
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
    model: type === "boiler" ? "EMS-ESP Heizkessel" : "EMS-ESP Thermostat",
    name: type === "boiler" ? "Buderus Heizkessel" : "Buderus Heizungsregler",
    ...(kind && { kind }),
    capabilities: Object.entries(values).map(([field, value]) => {
      const mappedSetpoint = type === "thermostat" && field === setpointField;
      return {
        id: mappedSetpoint ? "target_temperature_c" : capabilityId(type, field),
        label: mappedSetpoint ? "Solltemperatur" : field,
        type: valueType(value),
        readable: true,
        writable: mappedSetpoint && setpointControlHc2,
        supportStatus: "SUPPORTED",
        ...(mappedSetpoint && {
          min: RC35_HC2_SETPOINT_MIN_C,
          max: RC35_HC2_SETPOINT_MAX_C,
        }),
        ...(mappedSetpoint && { unit: "°C" }),
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
