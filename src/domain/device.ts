export type CapabilityValue = boolean | number | string;

interface CapabilityBase {
  id: string;
  label: string;
  readable: boolean;
  writable: boolean;
}

export type DeviceCapability =
  | (CapabilityBase & { type: "boolean" })
  | (CapabilityBase & { type: "number"; unit?: string; min?: number; max?: number })
  | (CapabilityBase & { type: "string" })
  | (CapabilityBase & { type: "enum"; values: readonly string[] });

export interface DeviceDefinition {
  id: string;
  adapterId: string;
  manufacturer: string;
  model: string;
  name: string;
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
