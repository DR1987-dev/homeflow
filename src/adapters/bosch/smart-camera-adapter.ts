import type {
  CapabilityReading,
  DeviceCommand,
  DeviceDefinition,
} from "../../domain/device.js";
import type { DeviceAdapter } from "../device-adapter.js";

export const BOSCH_SMART_CAMERA_ADAPTER_ID = "bosch-smart-camera";

export class BoschSmartCameraBlockedError extends Error {
  constructor() {
    super(
      "Bosch Smart Camera access is blocked: no API authorization for this Smart Camera App configuration is available.",
    );
    this.name = "BoschSmartCameraBlockedError";
  }
}

export class BoschSmartCameraAdapter implements DeviceAdapter {
  readonly id = BOSCH_SMART_CAMERA_ADAPTER_ID;
  readonly configurationStatus = "BLOCKED" as const;

  async discover(): Promise<readonly DeviceDefinition[]> {
    throw new BoschSmartCameraBlockedError();
  }

  async readState(_deviceId: string): Promise<readonly CapabilityReading[]> {
    throw new BoschSmartCameraBlockedError();
  }

  async execute(_command: DeviceCommand): Promise<void> {
    throw new BoschSmartCameraBlockedError();
  }
}
