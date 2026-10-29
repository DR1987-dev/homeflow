import { describe, expect, it } from "vitest";
import {
  BoschSmartCameraAdapter,
  BoschSmartCameraBlockedError,
} from "../src/adapters/bosch/smart-camera-adapter.js";

describe("Bosch Smart Camera adapter", () => {
  it("reports access as blocked and does not provide simulated devices", async () => {
    const adapter = new BoschSmartCameraAdapter();

    expect(adapter.configurationStatus).toBe("BLOCKED");
    await expect(adapter.discover()).rejects.toBeInstanceOf(BoschSmartCameraBlockedError);
    await expect(adapter.readState("camera-1")).rejects.toBeInstanceOf(BoschSmartCameraBlockedError);
    await expect(adapter.execute({
      deviceId: "camera-1",
      capabilityId: "privacy_mode",
      value: false,
    })).rejects.toBeInstanceOf(BoschSmartCameraBlockedError);
  });
});
