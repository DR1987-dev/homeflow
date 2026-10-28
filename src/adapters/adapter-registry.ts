import type { DeviceAdapter } from "./device-adapter.js";

export class DuplicateAdapterError extends Error {
  constructor(adapterId: string) {
    super(`Adapter "${adapterId}" is already registered.`);
    this.name = "DuplicateAdapterError";
  }
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, DeviceAdapter>();

  register(adapter: DeviceAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new DuplicateAdapterError(adapter.id);
    }

    this.adapters.set(adapter.id, adapter);
  }

  get(adapterId: string): DeviceAdapter | undefined {
    return this.adapters.get(adapterId);
  }
}
