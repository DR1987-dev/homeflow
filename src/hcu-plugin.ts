import { readFile } from "node:fs/promises";
import { ActionDispatcher, type ActionSafetyPolicy } from "./actions/action-dispatcher.js";
import { AdapterRegistry } from "./adapters/adapter-registry.js";
import { InMemoryEventBus } from "./events/event-bus.js";
import { DeviceRegistry } from "./registry/device-registry.js";
import { StateStore } from "./state/state-store.js";
import { AnkerSetup } from "./hcu/anker-setup.js";
import type { PluginMessage } from "./hcu/connect-api.js";
import { HcuBridge } from "./hcu/bridge.js";
import { HcuConnectClient } from "./hcu/connect-client.js";
import { HCU_SYSTEM_ADAPTER_ID, HcuSystem } from "./hcu/system.js";
import { isPropertyOfSelection, ShutterSelection } from "./automation/selection.js";
import { AutomationEngine } from "./automation/engine.js";
import {
  createShutterSunsetRule,
  DEFAULT_SHUTTER_CONFIG,
  ILLUMINANCE,
  SHUTTER_LEVEL,
  type ShutterSunsetConfig,
} from "./automation/shutter-sunset.js";
import { AutomationSwitch } from "./automation/switch.js";
import { AllowListSafetyPolicy, FileRunStore } from "./automation/support.js";

const pluginId = process.env.HCU_PLUGIN_ID ?? "de.rybosch.david.homeflow";
const host = process.env.HCU_HOST ?? "host.containers.internal";
const tokenFile = process.env.HCU_TOKEN_FILE ?? "/TOKEN";
const dataDir = process.env.HCU_DATA_DIR ?? "/data";
const log = (line: string) => console.log(line);

// Without an explicit automation config, no command may reach a device.
const denyAll: ActionSafetyPolicy = {
  authorize() {
    throw new Error("No safety policy is configured; control is disabled.");
  },
};

async function loadShutterConfig(): Promise<ShutterSunsetConfig | undefined> {
  try {
    const raw = JSON.parse(await readFile(`${dataDir}/shutter-sunset.json`, "utf8"));
    const config = { ...DEFAULT_SHUTTER_CONFIG, enabled: false, ...raw } as ShutterSunsetConfig;
    return config.enabled ? config : undefined;
  } catch {
    return undefined;
  }
}

const shutterConfig = await loadShutterConfig();
const SWITCH_ID = "automation:shutter-sunset";
const selection = new ShutterSelection({
  file: `${dataDir}/shutter-selection.json`,
  initial: shutterConfig?.shutterDeviceIds ?? [],
  candidates: () => devices.list().filter((device) => device.adapterId === HCU_SYSTEM_ADAPTER_ID),
});
await selection.load();
const safetyPolicy: ActionSafetyPolicy = shutterConfig
  ? new AllowListSafetyPolicy(() => [
      ...selection.ids.map((deviceId) => ({ deviceId, capabilityId: SHUTTER_LEVEL })),
      { deviceId: SWITCH_ID, capabilityId: "on" },
    ])
  : denyAll;

const bus = new InMemoryEventBus();
const state = new StateStore(bus);
const devices = new DeviceRegistry();
const adapters = new AdapterRegistry();
const dispatcher = new ActionDispatcher(devices, adapters, safetyPolicy);

const anker = new AnkerSetup({
  pluginId,
  dataFile: `${dataDir}/anker.json`,
  devices,
  adapters,
  bus,
  log,
});

const ANKER_KEYS = ["email", "password", "country"];

/** The HCU shows one configuration page per plugin, so the Anker and the shutter settings are merged here. */
async function handleConfig(message: PluginMessage): Promise<PluginMessage | undefined> {
  if (!shutterConfig) return undefined;
  if (message.type === "CONFIG_TEMPLATE_REQUEST") {
    const reply = await anker.handle(message);
    const base = (reply?.body ?? {}) as { groups?: object; properties?: object };
    const extra = selection.template();
    return {
      id: message.id,
      pluginId,
      type: "CONFIG_TEMPLATE_RESPONSE",
      body: {
        groups: { ...base.groups, ...extra.groups },
        properties: { ...base.properties, ...extra.properties },
      },
    };
  }
  if (message.type === "CONFIG_UPDATE_REQUEST") {
    const body = (message.body ?? {}) as { properties?: Record<string, unknown> };
    const properties = body.properties ?? {};
    const count = await selection.update(properties);
    log(`Shutter selection updated: ${count} device(s)/group(s).`);
    const ankerProperties = Object.fromEntries(
      Object.entries(properties).filter(
        ([key, value]) =>
          !isPropertyOfSelection(key) && ANKER_KEYS.includes(key) && typeof value === "string" && value.trim() !== "",
      ),
    );
    if (Object.keys(ankerProperties).length === 0) {
      return { id: message.id, pluginId, type: "CONFIG_UPDATE_RESPONSE", body: { status: "APPLIED" } };
    }
    return anker.handle({ ...message, body: { ...body, properties: ankerProperties } });
  }
  return undefined;
}

const system = new HcuSystem({
  pluginId,
  devices,
  adapters,
  bus,
  send: (message) => client.send(message),
  log,
});

const runStore = new FileRunStore(`${dataDir}/automation-state.json`);
await runStore.load();
const automationSwitch = shutterConfig
  ? new AutomationSwitch({
      deviceId: SWITCH_ID,
      name: "Rollladen-Automatik",
      file: `${dataDir}/automation-switches.json`,
      defaultOn: true,
      devices,
      adapters,
      bus,
    })
  : undefined;
await automationSwitch?.load();
const rule = shutterConfig
  ? { ...createShutterSunsetRule(shutterConfig, () => selection.ids), isEnabled: () => automationSwitch?.enabled ?? false }
  : undefined;
const engine = new AutomationEngine({
  rules: rule ? [rule] : [],
  state,
  dispatcher,
  runStore,
  getLocation: () => system.location,
  log,
});

const client = new HcuConnectClient({
  pluginId,
  host,
  token: await readFile(tokenFile, "utf8"),
  systemEvents: true,
  log,
  onOpen: () => {
    system.load().catch((error) => log(`HCU system state not loaded: ${error.message}`));
  },
  onMessage: async (message) =>
    (await system.handle(message)) ??
    (await handleConfig(message)) ??
    (await anker.handle(message)) ??
    bridge.handle(message),
});
const bridge = new HcuBridge({
  pluginId,
  devices,
  state,
  dispatcher,
  bus,
  send: (message) => client.send(message),
  log,
});

bridge.start();
await anker.load();
client.start();
if (rule) {
  engine.start();
  log(`Shutter automation active for ${selection.ids.join(", ") || "no shutters selected yet"} (sensor ${ILLUMINANCE} of ${shutterConfig!.sensorDeviceId}).`);
} else {
  log("Shutter automation inactive: /data/shutter-sunset.json missing or not enabled.");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    engine.stop();
    anker.stop();
    client.stop();
  });
}
