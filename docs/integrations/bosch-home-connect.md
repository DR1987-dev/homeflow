# Bosch Home Connect

## Status

The adapter uses the documented Home Connect API and supports dynamic appliance discovery and read-only state polling. It does not start or stop programs, set options, or subscribe to event streams. Those operations remain blocked until HomeFlow has per-appliance capability discovery, remote-control checks, explicit user authorization, deduplication, and post-action verification.

The API is an authorized cloud interface; appliances are not accessed directly. Home Connect supports a changing set of appliance types and features, so HomeFlow does not assume that every Bosch appliance or feature is supported.

## Access and setup

1. Register an application in the [Home Connect Developer Portal](https://developer.home-connect.com/applications) and obtain its client ID and client secret. The official authorization guide requires an application registration and OAuth 2.0 user consent. The client secret must remain private.
2. Obtain an authorized access token through the documented OAuth flow. Request only the scopes required by the features being used; `IdentifyAppliance` is required for API calls. The appropriate appliance scopes must also be granted to read state.
3. Configure the `HomeConnectClient` with the client credentials and access/refresh tokens. Keep these values outside source control and persist refreshed tokens through `onTokens` in a protected secret store.
4. Register the `HomeConnectAdapter` in the existing `AdapterRegistry`, discover its devices, register those definitions in the existing `DeviceRegistry`, and poll through `AdapterPoller` to feed `StateStore` and the existing event bus.

Home Connect access tokens expire after 24 hours according to the authorization documentation. The client refreshes an expiring or rejected token and invokes `onTokens` with the new token set. A refresh failure is reported; tokens are never written to logs.

### One-time terminal smoke test

The repository includes `scripts/home-connect-test.mjs`. It uses Home Connect's documented Device Authorization Flow, waits for the user to approve in a browser, and requests the authorized appliance list. It requires only the client ID; the access token stays in memory and is neither saved nor printed.

The application must have been registered with the **Device Flow** OAuth option. An application registered for Authorization Code Grant Flow cannot be switched to Device Flow according to the Developer Portal, so register a separate development application if needed. No callback listener or redirect URI is needed for this terminal flow.

```zsh
read "HOME_CONNECT_CLIENT_ID?Client ID: "
export HOME_CONNECT_CLIENT_ID
npm run home-connect:test
unset HOME_CONNECT_CLIENT_ID
```

Open the verification address printed by the script and enter the displayed user code, then approve access. It requests only `IdentifyAppliance`, which is sufficient for the appliance-list smoke test; it does not test device status, controls, or events. Stop the process with Ctrl-C if you need to cancel.

### Plugin setup (HCUweb)

On the plugin's HCUweb configuration page, enter the Home Connect **Client ID** (and optionally the **Client Secret**) and save. The plugin starts the Device Flow; reopen the page to see the verification address and user code in the Bosch Home Connect group, approve in the browser, and the appliances are registered read-only. Credentials and tokens are stored in `/data/home-connect.json` (mode 0600) and refreshed automatically; the secret is sent only to the Home Connect token endpoint. Polling runs every 10 minutes to respect API rate limits. Only `IdentifyAppliance` and `<Type>-Monitor` scopes are requested (falls back to `IdentifyAppliance` if the portal rejects them). Appliances appear in HomeFlow's registry, state store and event bus; the HCU does not display them because it has no matching device type. **UNVERIFIED** against a live HCU.

## Implemented capabilities

- Discover appliances returned for the authorized account, with API-provided IDs and metadata.
- Read the API-provided connected flag and primitive current status features.
- Keep all discovered capabilities read-only. Unknown or complex status values are not converted into HomeFlow capabilities.
- Surface API authorization, HTTP, malformed response, and offline errors rather than simulating successful readings.

## Not yet implemented

- Program selection/start/stop, options, remote-control state validation, and confirmation after actions: **BLOCKED**.
- Home Connect event streaming and event deduplication: **UNVERIFIED** in this adapter.
- Live account/device access: **UNVERIFIED**; no credentials or real appliance were available for verification.
- Device support is limited to the appliances, scopes, status fields, and values actually returned by the authorized API.

The official API documents programs, settings, status, events, and device-specific feature sets. Availability of a feature in the API does not mean that every appliance supports it or that a remote start is permitted. HomeFlow therefore rejects all Home Connect write actions by default.

## References

- [Home Connect API documentation](https://api-docs.home-connect.com/)
- [Authorization, scopes, and token refresh](https://api-docs.home-connect.com/authorization/)
- [Quickstart and application registration](https://api-docs.home-connect.com/quickstart)
- [Events and supported event types](https://api-docs.home-connect.com/events)
- [Developer program and appliance feature availability](https://developer.home-connect.com/how_it_works)
