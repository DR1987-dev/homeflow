# Bosch Smart Camera

## Status: BLOCKED

HomeFlow has an adapter boundary for a Bosch Smart Camera integration, but no production client is implemented. Discovery, state reads, and actions fail explicitly with a blocked status. The adapter does not contact the camera, the Bosch Smart Camera cloud, or the user's app account.

The target configuration is a Bosch 360° indoor camera installed with the Bosch Smart Camera App and no Bosch Smart Home Controller. Bosch's product help confirms that the 360° camera is set up through the Smart Camera App. The public Bosch Smart Home Cloud API is a partner integration that requires agreed use cases, signed agreements, assigned OAuth scopes and credentials, and validation before going live. No such partner authorization is available to this HomeFlow instance.

The Bosch-published `bosch-camera-api-docs` repository documents a **local Bosch Eyes Camera API**. That is not evidence that the standalone Smart Camera App/cloud account exposes the same interface, and it must not be used as a substitute for proof of compatibility with this camera configuration. The Smart Home Controller API is also unavailable because this installation has no controller.

## Feature status

| Feature | Status | Reason |
|---|---|---|
| Online status and metadata | BLOCKED | No documented authorization for this camera/app setup has been configured. |
| Movement/noise events | BLOCKED | No proven event source for this Smart Camera App configuration. |
| Read/control privacy mode | BLOCKED | No authorized API or permissions verified. |
| Snapshot, clips, or livestream | BLOCKED | No approved endpoint, media permission, or transport verified. |
| Camera position/rotation | BLOCKED | The available local Eyes Camera docs do not establish compatibility with the Smart Camera App cloud account. |

No private app endpoint, password reuse, TLS bypass, stream URL, or controller API is used. Camera media is never downloaded or logged. Privacy mode is never automatically changed.

## To unblock

Provide a Bosch-supported API/partner authorization that explicitly covers the 360° camera controlled by the Bosch Smart Camera App, along with approved scopes and the intended deployment model. Confirm the exact model and API compatibility first. Until then, camera triggers and camera actions must not be offered to automations.

## References

- [Bosch 360° Indoor Camera product help](https://www.bosch-smarthome.com/gb/en/support/help/product-help/360-indoor-camera-help/)
- [Bosch Smart Home Cloud API and scopes](https://www.bosch-smarthome.com/at/de/support/hilfe/hilfe-zur-kompatibilitaet/cloud-api/)
- [Bosch Smart Home API Partner onboarding](https://apidocs.bosch-smarthome.com/partner_onboarding.html)
- [Bosch Eyes Camera local API documentation](https://github.com/BoschSmartHome/bosch-camera-api-docs)
- [Bosch Smart Home Controller API](https://github.com/BoschSmartHome/bosch-shc-api-docs)
