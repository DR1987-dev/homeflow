import { readFile } from "node:fs/promises";
import { HcuConnectClient } from "./hcu/connect-client.js";

const pluginId = process.env.HCU_PLUGIN_ID ?? "de.rybosch.david.homeflow";
const host = process.env.HCU_HOST ?? "host.containers.internal";
const tokenFile = process.env.HCU_TOKEN_FILE ?? "/TOKEN";

const client = new HcuConnectClient({
  pluginId,
  host,
  token: await readFile(tokenFile, "utf8"),
  log: (line) => console.log(line),
});

client.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => client.stop());
}
