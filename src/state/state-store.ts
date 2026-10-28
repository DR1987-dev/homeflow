import type { CapabilityValue } from "../domain/device.js";
import type { EventBus } from "../events/event-bus.js";

/** Latest known values per device. Create it before any consumer subscribes to the same bus, so it is updated first. */
export class StateStore {
  private readonly values = new Map<string, Map<string, CapabilityValue>>();
  private readonly unreachable = new Set<string>();

  constructor(bus: EventBus) {
    bus.subscribe("device.state.changed", (event) => {
      const device = this.values.get(event.deviceId) ?? new Map<string, CapabilityValue>();
      device.set(event.capabilityId, event.value);
      this.values.set(event.deviceId, device);
    });
    bus.subscribe("device.availability.changed", (event) => {
      if (event.available) {
        this.unreachable.delete(event.deviceId);
      } else {
        this.unreachable.add(event.deviceId);
      }
    });
  }

  get(deviceId: string): ReadonlyMap<string, CapabilityValue> {
    return this.values.get(deviceId) ?? new Map();
  }

  isAvailable(deviceId: string): boolean {
    return !this.unreachable.has(deviceId);
  }
}
