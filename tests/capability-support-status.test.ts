import { describe, expect, it, vi } from "vitest";
import { AutomationEngine, InMemoryRunStore } from "../src/automation/engine.js";
import {
  ActionDispatcher,
  type ActionSafetyPolicy,
  CapabilityUnavailableError,
} from "../src/actions/action-dispatcher.js";
import { AdapterRegistry } from "../src/adapters/adapter-registry.js";
import type { DeviceAdapter } from "../src/adapters/device-adapter.js";
import type { DeviceDefinition } from "../src/domain/device.js";
import { InMemoryEventBus } from "../src/events/event-bus.js";
import { DeviceRegistry } from "../src/registry/device-registry.js";
import { StateStore } from "../src/state/state-store.js";

describe("capability support status", () => {
  it.each(["BLOCKED", "UNVERIFIED", "UNAVAILABLE"] as const)(
    "prevents the automation action boundary from executing a %s capability",
    async (supportStatus) => {
      const device: DeviceDefinition = {
        id: "bosch-device",
        adapterId: "bosch",
        manufacturer: "Bosch",
        model: "Mock",
        name: "Mock appliance",
        capabilities: [{
          id: "start",
          label: "Start",
          type: "boolean",
          readable: true,
          writable: true,
          supportStatus,
        }],
      };
      const devices = new DeviceRegistry();
      devices.register(device);
      const adapter: DeviceAdapter = {
        id: "bosch",
        discover: vi.fn().mockResolvedValue([device]),
        readState: vi.fn().mockResolvedValue([]),
        execute: vi.fn().mockResolvedValue(undefined),
      };
      const adapters = new AdapterRegistry();
      adapters.register(adapter);
      const policy: ActionSafetyPolicy = { authorize: vi.fn() };
      const dispatcher = new ActionDispatcher(devices, adapters, policy);
      const command = {
        deviceId: device.id,
        capabilityId: "start",
        value: true,
      } as const;
      const bus = new InMemoryEventBus();
      const log = vi.fn();
      const engine = new AutomationEngine({
        rules: [{ id: "bosch-action", evaluate: () => [command] }],
        state: new StateStore(bus),
        dispatcher,
        runStore: new InMemoryRunStore(),
        getLocation: () => undefined,
        log,
      });

      await engine.tick();

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(new CapabilityUnavailableError("start", supportStatus).message),
      );
      expect(policy.authorize).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
    },
  );
});
