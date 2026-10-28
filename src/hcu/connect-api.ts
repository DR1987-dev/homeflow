export interface PluginMessage<TBody = unknown> {
  id: string;
  pluginId: string;
  type: string;
  body: TBody;
}

export class InvalidPluginMessageError extends Error {
  constructor(reason: string) {
    super(`Invalid Connect API message: ${reason}`);
    this.name = "InvalidPluginMessageError";
  }
}

export function parsePluginMessage(raw: string): PluginMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidPluginMessageError("not valid JSON");
  }

  if (typeof value !== "object" || value === null) {
    throw new InvalidPluginMessageError("not an object");
  }
  const { id, pluginId, type, body } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof pluginId !== "string" || typeof type !== "string") {
    throw new InvalidPluginMessageError("id, pluginId and type must be strings");
  }

  return { id, pluginId, type, body: body ?? {} };
}

export function pluginStateResponse(pluginId: string, requestId: string): PluginMessage {
  return {
    id: requestId,
    pluginId,
    type: "PLUGIN_STATE_RESPONSE",
    body: { pluginReadinessStatus: "READY" },
  };
}

/** Returns the reply for messages HomeFlow already handles; other types are left to later modules. */
export function replyTo(pluginId: string, message: PluginMessage): PluginMessage | undefined {
  if (message.type === "PLUGIN_STATE_REQUEST") {
    return pluginStateResponse(pluginId, message.id);
  }
  return undefined;
}
