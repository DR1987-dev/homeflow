const clientId = process.env.HOME_CONNECT_CLIENT_ID;
const deviceAuthorizationUrl = "https://api.home-connect.com/security/oauth/device_authorization";
const tokenUrl = "https://api.home-connect.com/security/oauth/token";
const appliancesUrl = "https://api.home-connect.com/api/homeappliances";

if (!clientId) {
  console.error("Set HOME_CONNECT_CLIENT_ID first.");
  process.exit(1);
}

console.log("Requesting a Home Connect device authorization code...");
const deviceResponse = await fetch(deviceAuthorizationUrl, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    scope: "IdentifyAppliance",
  }),
});
const deviceBody = await readJson(deviceResponse, "device authorization");
if (!deviceResponse.ok) {
  console.error(
    `Device authorization failed (HTTP ${deviceResponse.status}): ${apiError(deviceBody)}`,
  );
  process.exit(1);
}

if (
  typeof deviceBody.device_code !== "string" ||
  typeof deviceBody.user_code !== "string" ||
  typeof deviceBody.verification_uri !== "string" ||
  typeof deviceBody.expires_in !== "number"
) {
  console.error("Device authorization response is missing required fields.");
  process.exit(1);
}

console.log("\nOpen this address and enter the code shown below:");
console.log(deviceBody.verification_uri);
console.log(`\nUser code: ${deviceBody.user_code}`);
if (typeof deviceBody.verification_uri_complete === "string") {
  console.log(`Or open: ${deviceBody.verification_uri_complete}`);
}
console.log("\nWaiting for approval...");

const accessToken = await pollForDeviceToken({
  clientId,
  deviceCode: deviceBody.device_code,
  intervalSeconds: typeof deviceBody.interval === "number" ? deviceBody.interval : 5,
  expiresInSeconds: deviceBody.expires_in,
});

console.log("Authorization received. Requesting the authorized appliance list...");
const applianceResponse = await fetch(appliancesUrl, {
  headers: {
    Accept: "application/vnd.bsh.sdk.v1+json",
    Authorization: `Bearer ${accessToken}`,
  },
});
const applianceBody = await readJson(applianceResponse, "appliance list");
if (!applianceResponse.ok) {
  console.error(
    `Appliance request failed (HTTP ${applianceResponse.status}): ${apiError(applianceBody)}`,
  );
  process.exit(1);
}

const appliances = applianceBody.data?.homeappliances;
if (!Array.isArray(appliances)) {
  console.error("The API response did not contain data.homeappliances.");
  process.exit(1);
}

console.log(`Success: Home Connect returned ${appliances.length} appliance(s).`);
for (const appliance of appliances) {
  console.log(
    `- ${safeText(appliance.name) ?? "(unnamed)"} | ${safeText(appliance.type) ?? "type unknown"} | ` +
      `ID: ${safeText(appliance.haId) ?? "unknown"} | ` +
      `connected: ${typeof appliance.connected === "boolean" ? appliance.connected : "unknown"}`,
  );
}
console.log("The access token was kept in memory only and was not saved or printed.");

async function pollForDeviceToken({ clientId, deviceCode, intervalSeconds, expiresInSeconds }) {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let intervalMs = intervalSeconds * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "device_code",
        device_code: deviceCode,
        client_id: clientId,
      }),
    });
    const body = await readJson(response, "device token");

    if (response.ok && typeof body.access_token === "string") {
      return body.access_token;
    }

    const error = typeof body.error === "string" ? body.error : undefined;
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (error === "access_denied" || error === "expired_token") {
      throw new Error(`Home Connect device authorization ${error}.`);
    }
    if (!response.ok) {
      throw new Error(`Device token request failed (HTTP ${response.status}): ${apiError(body)}`);
    }
    throw new Error("Device token response did not contain an access token.");
  }

  throw new Error("Home Connect device authorization timed out. Run the command again.");
}

async function readJson(response, description) {
  try {
    return await response.json();
  } catch {
    throw new Error(`Home Connect returned an invalid ${description} response.`);
  }
}

function apiError(body) {
  const error = body.error;
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && typeof error.description === "string") {
    return error.description;
  }
  return "The API did not provide an error description.";
}

function safeText(value) {
  return typeof value === "string" ? value.replace(/[\r\n]/g, " ") : undefined;
}
