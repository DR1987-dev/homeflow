import { readFile } from "node:fs/promises";
import { ActionDispatcher, type ActionSafetyPolicy } from "./actions/action-dispatcher.js";
import { AdapterRegistry } from "./adapters/adapter-registry.js";
import { InMemoryEventBus } from "./events/event-bus.js";
import { DeviceRegistry } from "./registry/device-registry.js";
import { StateStore } from "./state/state-store.js";
import { AnkerSetup } from "./hcu/anker-setup.js";
import { HomeConnectSetup } from "./hcu/home-connect-setup.js";
import type { PluginMessage } from "./hcu/connect-api.js";
import { HcuBridge } from "./hcu/bridge.js";
import { HcuConnectClient } from "./hcu/connect-client.js";
import { dateKey, localDate } from "./astro/sun.js";
import { HCU_SYSTEM_ADAPTER_ID, HcuSystem } from "./hcu/system.js";
import { ShutterSelection } from "./automation/selection.js";
import { AutomationEngine } from "./automation/engine.js";
import {
  createShutterSunsetRule,
  DEFAULT_SHUTTER_CONFIG,
  SHUTTER_LEVEL,
  type ShutterSunsetConfig,
} from "./automation/shutter-sunset.js";
import { SettingsError, ShutterSettings, type StatusSource } from "./automation/settings.js";
import { AutomationSwitch } from "./automation/switch.js";
import { AllowListSafetyPolicy, FileRunStore } from "./automation/support.js";

const pluginId = process.env.HCU_PLUGIN_ID ?? "de.rybosch.david.homeflow";
const host = process.env.HCU_HOST ?? "host.containers.internal";
const tokenFile = process.env.HCU_TOKEN_FILE ?? "/TOKEN";
const dataDir = process.env.HCU_DATA_DIR ?? "/data";
const log = (line: string) => console.log(line);

/** Optional initial values; everything can be changed later on the HCUweb configuration page. */
async function loadInitialConfig(): Promise<ShutterSunsetConfig> {
  const base: ShutterSunsetConfig = {
    ...DEFAULT_SHUTTER_CONFIG,
    enabled: true,
    shutterDeviceIds: [],
    sensorDeviceId: "",
  };
  try {
    const raw = JSON.parse(await readFile(`${dataDir}/shutter-sunset.json`, "utf8"));
    return { ...base, ...raw };
  } catch {
    return base;
  }
}

const shutterConfig = await loadInitialConfig();
const SWITCH_ID = "automation:shutter-sunset";
const selection = new ShutterSelection({
  file: `${dataDir}/shutter-selection.json`,
  initial: shutterConfig.shutterDeviceIds,
  candidates: () => devices.list().filter((device) => device.adapterId === HCU_SYSTEM_ADAPTER_ID),
});
await selection.load();
const safetyPolicy: ActionSafetyPolicy = new AllowListSafetyPolicy(() => [
  ...selection.ids.map((deviceId) => ({ deviceId, capabilityId: SHUTTER_LEVEL })),
  { deviceId: SWITCH_ID, capabilityId: "on" },
  ...homeConnect.allowedControlPairs(),
]);

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

const homeConnect = new HomeConnectSetup({
  pluginId,
  dataFile: `${dataDir}/home-connect.json`,
  devices,
  adapters,
  bus,
  log,
});

const ANKER_KEYS = ["email", "password", "country"];

/** The HCU shows one configuration page per plugin, so the Anker and the shutter settings are merged here. */
async function handleConfig(message: PluginMessage): Promise<PluginMessage | undefined> {
  if (message.type === "CONFIG_TEMPLATE_REQUEST") {
    const reply = await anker.handle(message);
    const base = (reply?.body ?? {}) as { groups?: object; properties?: object };
    const settingsTemplate = settings.template();
    const extra = selection.template();
    const homeConnectTemplate = homeConnect.template();
    return {
      id: message.id,
      pluginId,
      type: "CONFIG_TEMPLATE_RESPONSE",
      body: {
        groups: { ...base.groups, ...settingsTemplate.groups, ...extra.groups, ...homeConnectTemplate.groups },
        properties: {
          ...base.properties,
          ...settingsTemplate.properties,
          ...extra.properties,
          ...homeConnectTemplate.properties,
        },
      },
    };
  }
  if (message.type === "CONFIG_UPDATE_REQUEST") {
    const body = (message.body ?? {}) as { properties?: Record<string, unknown> };
    const properties = body.properties ?? {};
    try {
      await settings.update(properties);
    } catch (error) {
      if (error instanceof SettingsError) {
        return { id: message.id, pluginId, type: "CONFIG_UPDATE_RESPONSE", body: { status: "FAILED", message: error.message } };
      }
      throw error;
    }
    const count = await selection.update(properties);
    log(`Automation settings updated; ${count} shutter(s)/group(s) selected.`);
    const homeConnectResult = await homeConnect.update(properties);
    if (homeConnectResult.status === "FAILED") {
      return { id: message.id, pluginId, type: "CONFIG_UPDATE_RESPONSE", body: homeConnectResult };
    }
    const ankerProperties = Object.fromEntries(
      Object.entries(properties).filter(
        ([key, value]) =>
          ANKER_KEYS.includes(key) && typeof value === "string" && value.trim() !== "",
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
const automationSwitch = new AutomationSwitch({
  deviceId: SWITCH_ID,
  name: "Rollladen-Automatik",
  file: `${dataDir}/automation-switches.json`,
  defaultOn: true,
  devices,
  adapters,
  bus,
});
await automationSwitch.load();

const settings = new ShutterSettings({
  file: `${dataDir}/shutter-settings.json`,
  config: shutterConfig,
  candidates: () => devices.list().filter((device) => device.adapterId === HCU_SYSTEM_ADAPTER_ID),
  isEnabled: () => automationSwitch.enabled,
  doneToday: (now) =>
    runStore.get("shutter-sunset") === dateKey(localDate(now, system.location?.timeZone ?? "UTC")),
  setEnabled: (enabled) =>
    automationSwitch.execute({ deviceId: SWITCH_ID, capabilityId: "on", value: enabled }),
  status: (): StatusSource => rule,
  location: () => system.location,
});
await settings.load();

const rule = {
  ...createShutterSunsetRule(shutterConfig, () => selection.ids, (): string | undefined => settings.sensorId()),
  isEnabled: () => automationSwitch.enabled,
};
const engine = new AutomationEngine({
  rules: [rule],
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
await homeConnect.load();
client.start();
engine.start();
log(
  `Shutter automation ${automationSwitch.enabled ? "on" : "off"}; ${selection.ids.length} shutter(s)/group(s) selected, sensor ${settings.sensorId() ?? "not chosen"}.`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    engine.stop();
    anker.stop();
    homeConnect.stop();
    client.stop();
  });
}
