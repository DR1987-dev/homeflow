# Bosch device security

## Home Connect

- Use only the documented Home Connect API over HTTPS and user-authorized OAuth tokens.
- Request the minimum needed scopes; never place client secrets or tokens in source control or logs.
- Persist token refreshes in a protected secret store and restrict access to that store.
- Treat appliance metadata and each observed status feature as device-specific. A status feature is read-only.
- All Home Connect actions are blocked in HomeFlow until the implementation verifies the current device state, action prerequisites, freshness, explicit device/program approval, and duplicate-action protection.
- Do not infer a supported program, option, or remote-start permission from a product name.

## Bosch Smart Camera

- Production access is blocked until Bosch authorizes an API for the exact Smart Camera App configuration.
- Do not reuse camera-app credentials, reverse engineer private endpoints, bypass TLS, expose streams, or assume a Smart Home Controller exists.
- Keep camera media disabled by default; do not download or include images/clips in logs.
- Never automatically disable privacy mode. Do not expose camera events as automation triggers until an authorized source is verified.

## Shared automation behavior

The `ActionDispatcher` is the authorization boundary for writes. Any capability explicitly marked `UNVERIFIED`, `BLOCKED`, or `UNAVAILABLE` is rejected before the adapter is invoked. Capabilities without a status remain compatible with existing adapters; Bosch adapter capabilities explicitly declare their status. Existing safety policies remain required for any future writable device.

No public FRITZ!Box port forwarding or new runtime service is assumed.
