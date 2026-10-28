import type { EventBus } from "../events/event-bus.js";
import type { DeviceRegistry } from "../registry/device-registry.js";
import type { DeviceAdapter } from "./device-adapter.js";

export interface AdapterPollerOptions {
  adapter: DeviceAdapter;
  devices: DeviceRegistry;
  bus: EventBus;
  intervalMs: number;
  log?: (line: string) => void;
}

/** Polls an adapter and publishes only changed values and availability transitions. */
export class AdapterPoller {
  private readonly last = new Map<string, unknown>();
  private readonly available = new Map<string, boolean>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: AdapterPollerOptions) {}

  start(): void {
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.options.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async pollOnce(): Promise<void> {
    const { adapter, devices, bus, log } = this.options;
    for (const device of devices.list().filter((item) => item.adapterId === adapter.id)) {
      const observedAt = new Date().toISOString();
      try {
        const readings = await adapter.readState(device.id);
        await this.setAvailable(device.id, true, observedAt);
        for (const reading of readings) {
          const key = `${device.id}/${reading.capabilityId}`;
          if (this.last.get(key) !== reading.value) {
            this.last.set(key, reading.value);
            await bus.publish({
              type: "device.state.changed",
              deviceId: device.id,
              capabilityId: reading.capabilityId,
              value: reading.value,
              observedAt: reading.observedAt,
            });
          }
        }
      } catch (error) {
        log?.(`Polling "${device.id}" failed: ${error instanceof Error ? error.message : String(error)}`);
        await this.setAvailable(device.id, false, observedAt);
      }
    }
  }

  private async setAvailable(deviceId: string, available: boolean, observedAt: string): Promise<void> {
    if (this.available.get(deviceId) === available) {
      return;
    }
    this.available.set(deviceId, available);
    await this.options.bus.publish({ type: "device.availability.changed", deviceId, available, observedAt });
  }
}
