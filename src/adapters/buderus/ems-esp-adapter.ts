import type {
  CapabilityReading,
  DeviceCommand,
  DeviceDefinition,
  DeviceKind,
} from "../../domain/device.js";
import type { DeviceAdapter } from "../device-adapter.js";
import { EmsEspClient, type EmsEspDeviceData, type EmsEspValue } from "./ems-esp-client.js";

export const EMS_ESP_ADAPTER_ID = "buderus-ems-esp";

const DEVICE_TYPES = ["boiler", "thermostat"] as const;
type EmsEspDeviceType = (typeof DEVICE_TYPES)[number];

export class EmsEspAdapter implements DeviceAdapter {
  readonly id = EMS_ESP_ADAPTER_ID;
  private known = new Map<string, EmsEspDeviceData>();

  constructor(private readonly client: EmsEspClient) {}

  async discover(): Promise<readonly DeviceDefinition[]> {
    const definitions: DeviceDefinition[] = [];
    const known = new Map<string, EmsEspDeviceData>();
    for (const type of DEVICE_TYPES) {
      const data = await this.client.fetchDevice(type);
      if (!data) {
        continue;
      }
      known.set(deviceId(type), data);
      definitions.push(toDefinition(type, data.values));
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
    const setpointField = type === "thermostat" ? findSetpointField(data.values) : undefined;
    return Object.entries(data.values).map(([field, value]) => ({
      capabilityId:
        type === "thermostat" && field === setpointField
          ? "target_temperature_c"
          : capabilityId(type, field),
      value,
      observedAt,
    }));
  }

  async execute(_command: DeviceCommand): Promise<void> {
    throw new Error("EMS-ESP-Steuerung ist in HomeFlow deaktiviert; die Integration ist nur lesend.");
  }
}

function toDefinition(type: EmsEspDeviceType, values: Readonly<Record<string, EmsEspValue>>): DeviceDefinition {
  const setpointField = type === "thermostat" ? findSetpointField(values) : undefined;
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
        writable: false,
        supportStatus: "SUPPORTED",
        ...(mappedSetpoint && { unit: "°C" }),
      };
    }),
  };
}

function findSetpointField(values: Readonly<Record<string, EmsEspValue>>): string | undefined {
  return Object.keys(values).find((field) =>
    /(^|_)(seltemp|setpoint|set_temp|target_temperature|targettemp)(_|$)/i.test(field),
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
