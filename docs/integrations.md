# Integrationsstatus

Stand der Recherche: 28.10.2026. „Nicht nachgewiesen“ bedeutet, dass HomeFlow diese Schnittstelle nicht als verfügbar voraussetzt; es ist keine Aussage, dass ein Gerät grundsätzlich keine Schnittstelle besitzt.

## Geräte aus dem aktuellen Haushalt

| System | Modell | Bekannter Weg | HomeFlow-Status |
|---|---|---|---|
| Anker SOLIX | Solarbank 3 | Die offizielle Home Assistant Integration arbeitet lokal über Modbus TCP, dokumentiert aber nur eine konkrete Liste aktiver Modelle. Solarbank 3 ist dort nicht gelistet. | Noch kein unterstützter Adapter. Modell-/Firmware-spezifische Modbus-Unterstützung muss vor einer Implementierung nachgewiesen werden. Nicht auf eine inoffizielle Cloud-API ausweichen, ohne dies ausdrücklich zu entscheiden. |
| Buderus | GB125-18 mit RC35 | Die recherchierte Community-Integration „Buderus MX300/MX400“ nutzt eine inoffizielle MyBuderus/PointT-Cloud-API für Systeme mit MX300/MX400/K30. Sie belegt keine Unterstützung für GB125-18/RC35. | Kein kompatibler Weg für das genannte Modell nachgewiesen. Vor Adapterentwicklung Heizungsbus, vorhandenes Gateway und verfügbaren Datenumfang feststellen. |
| Homematic IP | HCU1 | Offizielle **Connect API 1.0.1** (eQ-3, Apache-2.0): Plugins laufen als ARM64-Container auf der HCU1 oder remote im LAN und sprechen per WebSocket (Port 9001) mit der HCU. Plugins können Fremdgeräte einbinden, HCU-Geräte steuern und Systemereignisse empfangen. | Plugin-Gerüst vorhanden (`src/hcu/`, `Dockerfile.hcu`): Verbindung, Authentifizierung und `PLUGIN_STATE`-Handshake. Gerätesynchronisation, Steuerung und Systemereignisse sind noch nicht implementiert. Nicht auf realer HCU1 getestet. |

## Konsequenzen für die Architektur

- Adapter sprechen ausschließlich das herstellerneutrale HomeFlow-Geräte- und Fähigkeitsmodell an.
- Nicht erreichbare oder nicht unterstützte Fähigkeiten werden nicht registriert; Aktionen werden nicht stillschweigend simuliert.
- Die Action Dispatcher-Grenze verlangt eine explizite Safety-/Berechtigungsrichtlinie und prüft zusätzlich Fähigkeit, Datentyp und deklarierte Grenzen.
- Anker-Modbus, Buderus-Zugriff und HCU1-Anbindung sind eigenständige Adapterentscheidungen.
- Der Betrieb als HCU1-Plugin ist ein optionaler Deployment-Modus. Der Kern bleibt hostunabhängig (Docker auf Pi/Mini-PC/NAS) und setzt keine Laufzeit auf HCU1 oder FRITZ!Box voraus. Ressourcen der HCU1 (CPU/RAM, USB-Speicher) sind nicht dokumentiert und müssen vor produktivem Einsatz gemessen werden.
- Die FRITZ!Box bietet keine Docker-Unterstützung und scheidet als Laufzeit aus.

## HCU1-Plugin: Voraussetzungen und Installation

1. In HCUweb den **Entwicklermodus** aktivieren. Laut Connect-API-Dokumentation kann er nach dem Anlegen eines Connect-API-Clients **nicht mehr deaktiviert** werden. Eigene Plugins lassen sich nur bei aktivem Entwicklermodus installieren.
2. Image bauen: `docker build --platform linux/arm64 -f Dockerfile.hcu -t de/rybosch/david/homeflow:0.1.0 .`
3. Exportieren: `docker save de/rybosch/david/homeflow:0.1.0 | gzip > homeflow-hcu-plugin.tar.gz` (alternativ als Artefakt aus dem CI-Job `hcu-plugin`).
4. Archiv in HCUweb auf der Plugin-Seite hochladen.

Die HCU stellt dem Container `/TOKEN`, `/CLIENTID`, `/SGTIN` und das persistente Verzeichnis `/data` bereit und erreicht sich unter `wss://host.containers.internal:9001`. Für Entwicklung ohne Installation kann das Plugin remote laufen (`HCU_HOST=hcu1-XXXX.local`, `HCU_TOKEN_FILE=<Datei>`), wenn der WebSocket in HCUweb freigegeben ist. Die Plugin-ID ist über `HCU_PLUGIN_ID` änderbar, muss dann aber auch im Label in `Dockerfile.hcu` angepasst werden.

Offen: Das Basis-Image `ghcr.io/homematicip/alpine-node-simple:0.0.1` stammt aus dem offiziellen Beispiel; seine Node-Version ist nicht dokumentiert. `hcuMinVersion` (1.4.7) ist der Wert aus dem Beispiel, nicht gemessen.

## Quellen

- [Anker SOLIX Official Home Assistant Integration](https://github.com/anker-charging/ha-anker-solix-official) – lokale Modbus-TCP-Verbindung und Modell-/Firmwareliste.
- [Buderus MX300/MX400 Home Assistant Integration](https://github.com/BassXT/buderus) – experimentelle PointT-Cloud-Integration; nennt MX300/MX400/K30 als getestete Gateways und dokumentiert Einschränkungen.
- [Homematic IP Connect API](https://github.com/homematicip/connect-api) – offizielle Plugin-API der HCU (Dokumentation 1.0.1: Containerisierung, WebSocket, Nachrichten).
- [Homematic IP Home Control Unit](https://homematic-ip.com/en/product/home-control-unit) – beschreibt Online-/Offline-Modus und EEBUS-Funktionalität.
- [Home Assistant HomematicIP Cloud](https://www.home-assistant.io/integrations/homematicip_cloud/) – beschreibt den Zugriff auf den Cloud-Server per nicht offiziell dokumentierter, reverse-engineerter API und Access-Point-Konfiguration.
