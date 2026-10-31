# Automation rules

HomeFlow automation rules evaluate conditions and produce `DeviceCommand`s. All commands pass through the existing `ActionDispatcher`, which checks the registered device/capability, value type and bounds, safety policy, and adapter before execution.

Capabilities marked `UNVERIFIED`, `BLOCKED`, or `UNAVAILABLE` cannot be used for writes. A missing support status preserves legacy behavior for existing integrations, so new adapter capabilities must set an explicit status.

## Current Bosch boundary

- Home Connect contributes discovered read-only state through the existing adapter and event-bus path. Program starts/stops, settings, event streaming, and alarm-triggered actions are not enabled.
- The Bosch Smart Camera adapter is `BLOCKED`; it cannot discover devices, report state, or execute commands. Camera triggers must not be added to rules.

## Future coffee-after-alarm rule

A future implementation would require an authenticated, versioned user-submitted alarm event and a rule that separately verifies it is enabled, explicitly approved for the exact appliance/program, fresh, not duplicated, online, and currently allowed to start remotely. The resulting action would require post-action state verification and audit logging. This is a design constraint, not an available feature.
