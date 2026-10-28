import { describe, expect, it } from "vitest";
import {
  InvalidPluginMessageError,
  parsePluginMessage,
  replyTo,
} from "../src/hcu/connect-api.js";

describe("Connect API messages", () => {
  it("answers a plugin state request with the same message id", () => {
    const request = parsePluginMessage(
      JSON.stringify({ id: "abc", pluginId: "p", type: "PLUGIN_STATE_REQUEST", body: {} }),
    );

    expect(replyTo("p", request)).toEqual({
      id: "abc",
      pluginId: "p",
      type: "PLUGIN_STATE_RESPONSE",
      body: { pluginReadinessStatus: "READY" },
    });
  });

  it("leaves other message types to later modules", () => {
    const message = parsePluginMessage(
      JSON.stringify({ id: "1", pluginId: "p", type: "DISCOVER_REQUEST" }),
    );

    expect(replyTo("p", message)).toBeUndefined();
  });

  it("rejects malformed input", () => {
    expect(() => parsePluginMessage("nope")).toThrow(InvalidPluginMessageError);
    expect(() => parsePluginMessage(JSON.stringify({ id: 1 }))).toThrow(InvalidPluginMessageError);
  });
});
