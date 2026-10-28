import { describe, expect, it, vi } from "vitest";
import { InMemoryEventBus } from "../src/events/event-bus.js";

describe("InMemoryEventBus", () => {
  it("publishes typed events and supports unsubscription", async () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe("device.availability.changed", handler);
    const event = {
      type: "device.availability.changed",
      deviceId: "boiler",
      available: false,
      observedAt: "2026-10-28T12:00:00.000Z",
    } as const;

    await bus.publish(event);
    unsubscribe();
    await bus.publish(event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("surfaces subscriber errors to the publisher", async () => {
    const bus = new InMemoryEventBus();
    bus.subscribe("device.availability.changed", () => {
      throw new Error("subscriber failed");
    });

    await expect(
      bus.publish({
        type: "device.availability.changed",
        deviceId: "boiler",
        available: false,
        observedAt: "2026-10-28T12:00:00.000Z",
      }),
    ).rejects.toThrow("subscriber failed");
  });
});
