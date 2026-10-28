import { readFile } from "node:fs/promises";
import { ActionDispatcher, type ActionSafetyPolicy } from "./actions/action-dispatcher.js";
import { AdapterRegistry } from "./adapters/adapter-registry.js";
import { InMemoryEventBus } from "./events/event-bus.js";
import { DeviceRegistry } from "./registry/device-registry.js";
import { StateStore } from "./state/state-store.js";
import { AnkerSetup } from "./hcu/anker-setup.js";
import { HcuBridge } from "./hcu/bridge.js";
import { HcuConnectClient } from "./hcu/connect-client.js";

const pluginId = process.env.HCU_PLUGIN_ID ?? "de.rybosch.david.homeflow";
const host = process.env.HCU_HOST ?? "host.containers.internal";
const tokenFile = process.env.HCU_TOKEN_FILE ?? "/TOKEN";
const dataDir = process.env.HCU_DATA_DIR ?? "/data";
const log = (line: string) => console.log(line);

// Until the safety module exists, no command may reach a device.
const denyAll: ActionSafetyPolicy = {
  authorize() {
    throw new Error("No safety policy is configured; control is disabled.");
  },
};

const bus = new InMemoryEventBus();
const state = new StateStore(bus);
const devices = new DeviceRegistry();
const adapters = new AdapterRegistry();
const dispatcher = new ActionDispatcher(devices, adapters, denyAll);

const anker = new AnkerSetup({
  pluginId,
  dataFile: `${dataDir}/anker.json`,
  devices,
  adapters,
  bus,
  log,
});

const client = new HcuConnectClient({
  pluginId,
  host,
  token: await readFile(tokenFile, "utf8"),
  log,
  onMessage: async (message) => (await anker.handle(message)) ?? bridge.handle(message),
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    anker.stop();
    client.stop();
  });
}
