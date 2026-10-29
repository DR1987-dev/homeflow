export type CapabilityValue = boolean | number | string;
export type CapabilitySupportStatus = "SUPPORTED" | "UNVERIFIED" | "BLOCKED" | "UNAVAILABLE";

interface CapabilityBase {
  id: string;
  label: string;
  readable: boolean;
  writable: boolean;
  supportStatus?: CapabilitySupportStatus;
}

export type DeviceCapability =
  | (CapabilityBase & { type: "boolean" })
  | (CapabilityBase & { type: "number"; unit?: string; min?: number; max?: number })
  | (CapabilityBase & { type: "string" })
  | (CapabilityBase & { type: "enum"; values: readonly string[] });

export type DeviceKind =
  | "battery"
  | "inverter"
  | "energy-meter"
  | "grid-connection-point"
  | "heat-pump"
  | "thermostat"
  | "switch";

export interface DeviceDefinition {
  id: string;
  adapterId: string;
  manufacturer: string;
  model: string;
  name: string;
  kind?: DeviceKind;
  capabilities: readonly DeviceCapability[];
}

export interface CapabilityReading {
  capabilityId: string;
  value: CapabilityValue;
  observedAt: string;
}

export interface DeviceCommand {
  deviceId: string;
  capabilityId: string;
  value: CapabilityValue;
}
