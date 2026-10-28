// Einmalige Registrierung eines Connect-API-Clients an der HCU1 (Doku 2.4).
// Aufruf: node scripts/hcu-register.mjs hcu1-XXXX.local [plugin-id] [token-datei]
import { request } from "node:https";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const host = process.argv[2];
const pluginId = process.argv[3] ?? "de.rybosch.david.homeflow";
const tokenFile = process.argv[4] ?? join(homedir(), "homeflow-hcu.token");

if (!host) {
  console.error("Usage: node scripts/hcu-register.mjs hcu1-XXXX.local [plugin-id] [token-file]");
  process.exit(1);
}

function readSecret(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => {
      if (text.includes(prompt)) {
        process.stdout.write(text);
      }
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

// Die HCU nutzt ein selbstsigniertes Zertifikat.
function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        host,
        port: 6969,
        path,
        method: "POST",
        rejectUnauthorized: false,
        headers: { VERSION: "12", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} on ${path}: ${data}`));
            return;
          }
          resolve(JSON.parse(data));
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const activationKey = await readSecret("Aktivierungsschlüssel (Eingabe verdeckt): ");

const { authToken } = await post("/hmip/auth/requestConnectApiAuthToken", {
  activationKey,
  pluginId,
  friendlyName: { de: "HomeFlow", en: "HomeFlow" },
});
const { clientId } = await post("/hmip/auth/confirmConnectApiAuthToken", { activationKey, authToken });

await writeFile(tokenFile, authToken, { mode: 0o600 });
console.log(`Client ${clientId} angelegt. Token gespeichert in ${tokenFile}`);
