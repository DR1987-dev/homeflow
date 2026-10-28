import type {
  CapabilityReading,
  DeviceCommand,
  DeviceDefinition,
} from "../domain/device.js";

export interface DeviceAdapter {
  readonly id: string;
  discover(): Promise<readonly DeviceDefinition[]>;
  readState(deviceId: string): Promise<readonly CapabilityReading[]>;
  execute(command: DeviceCommand): Promise<void>;
}
