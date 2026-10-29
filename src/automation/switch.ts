import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AdapterRegistry } from "../adapters/adapter-registry.js";
import type { DeviceAdapter } from "../adapters/device-adapter.js";
import type { CapabilityReading, DeviceCommand, DeviceDefinition } from "../domain/device.js";
import type { EventBus } from "../events/event-bus.js";
import type { DeviceRegistry } from "../registry/device-registry.js";

export const AUTOMATION_ADAPTER_ID = "automation";

/** A virtual on/off switch (offered to the HCU as a switch) that enables or disables one automation. */
export class AutomationSwitch implements DeviceAdapter {
  readonly id = AUTOMATION_ADAPTER_ID;
  readonly definition: DeviceDefinition;
  private on: boolean;

  constructor(
    private readonly options: {
      deviceId: string;
      name: string;
      file: string;
      defaultOn: boolean;
      devices: DeviceRegistry;
      adapters: AdapterRegistry;
      bus: EventBus;
    },
  ) {
    this.on = options.defaultOn;
    this.definition = {
      id: options.deviceId,
      adapterId: AUTOMATION_ADAPTER_ID,
      manufacturer: "HomeFlow",
      model: "Automation",
      name: options.name,
      kind: "switch",
      capabilities: [{ id: "on", label: "Enabled", type: "boolean", readable: true, writable: true }],
    };
    options.adapters.register(this);
    options.devices.register(this.definition);
  }

  get enabled(): boolean {
    return this.on;
  }

  /** Restores the persisted state and publishes it so the HCU and state store see it. */
  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.options.file, "utf8")) as Record<string, unknown>;
      const value = saved[this.options.deviceId];
      if (typeof value === "boolean") {
        this.on = value;
      }
    } catch {
      // No saved state yet: the default applies.
    }
    await this.publish();
  }

  async discover(): Promise<readonly DeviceDefinition[]> {
    return [this.definition];
  }

  async readState(): Promise<readonly CapabilityReading[]> {
    return [{ capabilityId: "on", value: this.on, observedAt: new Date().toISOString() }];
  }

  async execute(command: DeviceCommand): Promise<void> {
    if (command.deviceId !== this.options.deviceId || command.capabilityId !== "on" || typeof command.value !== "boolean") {
      throw new Error(`Unsupported command for "${command.deviceId}"`);
    }
    this.on = command.value;
    await this.persist();
    await this.publish();
  }

  private async persist(): Promise<void> {
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(await readFile(this.options.file, "utf8")) as Record<string, unknown>;
    } catch {
      // First write.
    }
    saved[this.options.deviceId] = this.on;
    await mkdir(dirname(this.options.file), { recursive: true });
    await writeFile(this.options.file, JSON.stringify(saved), "utf8");
  }

  private async publish(): Promise<void> {
    await this.options.bus.publish({
      type: "device.state.changed",
      deviceId: this.options.deviceId,
      capabilityId: "on",
      value: this.on,
      observedAt: new Date().toISOString(),
    });
  }
}
