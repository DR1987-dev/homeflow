import type { CapabilityValue } from "../domain/device.js";

export interface HomeFlowEvents {
  "device.state.changed": {
    type: "device.state.changed";
    deviceId: string;
    capabilityId: string;
    value: CapabilityValue;
    observedAt: string;
  };
  "device.availability.changed": {
    type: "device.availability.changed";
    deviceId: string;
    available: boolean;
    observedAt: string;
  };
}

export type EventHandler<T> = (event: T) => void | Promise<void>;

export interface EventBus {
  subscribe<K extends keyof HomeFlowEvents>(
    type: K,
    handler: EventHandler<HomeFlowEvents[K]>,
  ): () => void;
  publish<K extends keyof HomeFlowEvents>(event: HomeFlowEvents[K]): Promise<void>;
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers: {
    [K in keyof HomeFlowEvents]: Set<EventHandler<HomeFlowEvents[K]>>;
  } = {
    "device.state.changed": new Set(),
    "device.availability.changed": new Set(),
  };

  subscribe<K extends keyof HomeFlowEvents>(
    type: K,
    handler: EventHandler<HomeFlowEvents[K]>,
  ): () => void {
    this.handlers[type].add(handler);
    return () => this.handlers[type].delete(handler);
  }

  async publish<K extends keyof HomeFlowEvents>(event: HomeFlowEvents[K]): Promise<void> {
    const handlers = this.handlers[event.type] as Set<EventHandler<HomeFlowEvents[K]>>;
    for (const handler of handlers) {
      await handler(event);
    }
  }
}
