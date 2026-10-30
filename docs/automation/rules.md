# Automation rules

HomeFlow automation rules evaluate conditions and produce `DeviceCommand`s. All commands pass through the existing `ActionDispatcher`, which checks the registered device/capability, value type and bounds, safety policy, and adapter before execution.

Capabilities marked `UNVERIFIED`, `BLOCKED`, or `UNAVAILABLE` cannot be used for writes. A missing support status preserves legacy behavior for existing integrations, so new adapter capabilities must set an explicit status.

## Current Bosch boundary

- Home Connect contributes discovered state and opt-in coffee-maker power switches. Program starts/stops and event streaming are not enabled for this alarm integration.
- The Bosch Smart Camera adapter is `BLOCKED`; it cannot discover devices, report state, or execute commands. Camera triggers must not be added to rules.
- iPhone alarm events are submitted by a local authenticated Shortcuts endpoint. HomeFlow cannot read iOS alarm data or determine whether the user is home; the Shortcut must check location before making the request.

## Coffee maker after an iPhone alarm

The HCU plugin exposes `POST /v1/shortcuts/alarm` on port `8787` by default. It binds to the network interfaces but accepts requests only from private/link-local addresses, requires a bearer token of at least 32 characters, rate-limits requests, and remembers the latest 2048 event UUIDs to reject duplicate requests. The token and replay cache are stored in `/data` with owner-only file permissions. The endpoint accepts no device ID or command from the caller.

To enable it:

1. In HCUweb, configure Home Connect control, approve its requested scopes, and enable the **Power** switch for exactly one CoffeeMaker. Do not enable a program switch for this automation. HomeFlow will reject the alarm request unless exactly one coffee power switch is enabled and authorized.
2. Generate a random token on a trusted computer, for example with `openssl rand -hex 32`. Paste the same value into the HCUweb **Geheimer Kurzbefehle-Token** field and the iPhone Shortcut below. Keep it private; the HCU configuration does not display it again.
3. In the HCUweb plugin configuration, enable **Wecker-Aufruf erlauben** and save. Check the plugin log for `Alarm shortcut endpoint listening on port 8787`. If the port cannot be bound, the configuration update reports an error.
4. In Shortcuts, create a personal automation triggered by the alarm. First compare the iPhone's current location with your home address and continue only when it is within your chosen radius.
5. Add **Aktuelles Datum** and **Zufällige Zahl** (for example 1 to 99999999). Add **Text** and insert both values, separated by a hyphen, to form a fresh event ID for each alarm. Then add **Inhalt von URL abrufen** with URL `http://<LAN-IP-der-HCU>:8787/v1/shortcuts/alarm`, method `POST`, request body `JSON`, and one field `eventId` set to that text. Add the header `Authorization` with value `Bearer <dein-token>`.
6. Disable **Ask Before Running** for the personal automation. Test the endpoint only while the iPhone and HomeFlow are on the same private network.

The endpoint only sets the enabled CoffeeMaker **Power** switch to on; it does not start a configured brew program. It is plain HTTP and should stay on a trusted private network; do not port-forward it to the internet. Whether inbound port `8787` is reachable on the HCU1 plugin container depends on HCU networking and has not been verified. If the HCU1 does not expose it, run the plugin on a reachable LAN host with its HCU WebSocket connection, or provide a private LAN port mapping. The location check is performed by iOS, not independently verified by HomeFlow.
