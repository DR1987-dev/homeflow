# Integrationsstatus

Stand der Recherche: 28.10.2026. „Nicht nachgewiesen“ bedeutet, dass HomeFlow diese Schnittstelle nicht als verfügbar voraussetzt; es ist keine Aussage, dass ein Gerät grundsätzlich keine Schnittstelle besitzt.

## Bosch

| Integration | HomeFlow-Status |
|---|---|
| [Bosch Home Connect](./integrations/bosch-home-connect.md) | OAuth-geschützte Geräteliste und dynamische, schreibgeschützte Statuswerte sind implementiert. Keine Gerätezugangsdaten oder reale Appliance für Live-Tests vorhanden. Steuerung und Ereignisstream bleiben gesperrt bzw. ungeprüft. |
| [Bosch Smart Camera](./integrations/bosch-smart-camera.md) | `BLOCKED`: für die Bosch Smart Camera App ist keine autorisierte API-Konfiguration belegt. Es wird kein Kamera- oder Medienzugriff versucht. |

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
2. Image bauen und exportieren:
   ```sh
   VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")"
   docker build --platform linux/arm64 -f Dockerfile.hcu --build-arg PLUGIN_VERSION="$VERSION" -t "de/rybosch/david/homeflow:$VERSION" .
   docker save "de/rybosch/david/homeflow:$VERSION" | gzip > homeflow-hcu-plugin.tar.gz
   ```
   Die Plugin-Metadaten erhalten die Version aus `PLUGIN_VERSION`. CI verwendet bei `v*`-Tags die Tag-Version ohne `v`, sonst die Version aus `package.json`.
3. Archiv in HCUweb auf der Plugin-Seite hochladen (alternativ das Artefakt aus dem CI-Job `hcu-plugin` verwenden).

Die HCU stellt dem Container `/TOKEN`, `/CLIENTID`, `/SGTIN` und das persistente Verzeichnis `/data` bereit und erreicht sich unter `wss://host.containers.internal:9001`. Für Entwicklung ohne Installation kann das Plugin remote laufen (`HCU_HOST=hcu1-XXXX.local`, `HCU_TOKEN_FILE=<Datei>`), wenn der WebSocket in HCUweb freigegeben ist. Die Plugin-ID ist über `HCU_PLUGIN_ID` änderbar, muss dann aber auch im Label in `Dockerfile.hcu` angepasst werden.

Offen: Das Basis-Image `ghcr.io/homematicip/alpine-node-simple:0.0.1` stammt aus dem offiziellen Beispiel; seine Node-Version ist nicht dokumentiert. `hcuMinVersion` (1.4.7) ist der Wert aus dem Beispiel, nicht gemessen.

## Quellen

- [Anker SOLIX Official Home Assistant Integration](https://github.com/anker-charging/ha-anker-solix-official) – lokale Modbus-TCP-Verbindung und Modell-/Firmwareliste.
- [Buderus MX300/MX400 Home Assistant Integration](https://github.com/BassXT/buderus) – experimentelle PointT-Cloud-Integration; nennt MX300/MX400/K30 als getestete Gateways und dokumentiert Einschränkungen.
- [Homematic IP Connect API](https://github.com/homematicip/connect-api) – offizielle Plugin-API der HCU (Dokumentation 1.0.1: Containerisierung, WebSocket, Nachrichten).
- [Homematic IP Home Control Unit](https://homematic-ip.com/en/product/home-control-unit) – beschreibt Online-/Offline-Modus und EEBUS-Funktionalität.
- [Home Assistant HomematicIP Cloud](https://www.home-assistant.io/integrations/homematicip_cloud/) – beschreibt den Zugriff auf den Cloud-Server per nicht offiziell dokumentierter, reverse-engineerter API und Access-Point-Konfiguration.

## HCU-Geräte-Mapping

`src/hcu/device-mapper.ts` und `src/hcu/bridge.ts` bilden HomeFlow-Geräte auf die Connect-API ab.

- Ein Gerät wird nur angeboten, wenn `kind` gesetzt ist (`battery`, `inverter`, `energy-meter`, `grid-connection-point`, `heat-pump`, `thermostat`, `switch`) und das für den HCU-Archetyp nötige Feature vorhanden ist. Werte werden nie erfunden.
- Standard-Capability-IDs: `battery_level` (%, wird zu 0..1), `battery_capacity_wh`, `power_w`, `energy_in_kwh`, `energy_out_kwh`, `target_temperature_c`, `operation_mode`, `on`.
- `CONTROL_REQUEST` läuft über den `ActionDispatcher` und damit durch die Safety-Policy. Im Plugin ist aktuell eine Deny-all-Policy aktiv: Steuerung ist gesperrt, bis ein Safety-Modul existiert.
- Der Inklusionsstatus liegt nur im Speicher (nicht persistent).
- Die Geräteliste ist leer, solange keine Adapter (Anker, Buderus) existieren.

## Anker Solarbank (Cloud, nur lesend)

- Adapter: `src/adapters/anker/`. Nutzt die **inoffizielle** Anker-Cloud-API (reverse engineered von [thomluther/anker-solix-api](https://github.com/thomluther/anker-solix-api), MIT). Sie kann sich jederzeit ändern oder wegfallen.
- Nur Monitoring: Ladestand (`battery_level`), Solarleistung (`pv_power_w`), Ausgangsleistung (`output_power_w`). Steuern ist nicht implementiert.
- Der Solarbank 3 (A17C5) wird von der Bibliothek unterstützt. Die Feldnamen der Scene-Info-Antwort für den SB3 sind **nicht an einem echten Gerät verifiziert**.
- Abfrage alle 60 s (Cloud-Limits), Antworten 30 s gecacht.
- Konfiguration in HCUweb (Plugin → Konfiguration): E-Mail, Passwort, Land. Die Zugangsdaten liegen in `/data/anker.json` (Rechte 600) im Plugin-Container, nicht im Repository.

### Anker Smart Meter (nur lesend)

- Wird aus `grid_info` der Scene-Info des Solarbank-Systems gelesen (`grid_list`, `grid_to_home_power`, `photovoltaic_to_grid_power`) und als `energy-meter` angeboten: `power_w` (Bezug positiv, Einspeisung negativ), `grid_import_w`, `grid_export_w`.
- Die Werte gelten für den ganzen Standort. Das Verhalten mit einem Anker Smart Meter (A17X7) ist **nicht an einem echten Gerät verifiziert**. Es ist ungeklärt, ob die HCU negative `currentPower`-Werte akzeptiert.
- Es gibt keine Energiezähler (kWh) für den Meter, weil die Cloud sie nur über zusätzliche, begrenzte Statistik-Endpunkte liefert.

### Anker Energiebilanz (kWh)

- Quelle: Endpunkt `energy_analysis` (Tageswerte der Anker-App) für `grid` (Netzbezug `grid_to_home_total`, Einspeisung `solar_to_grid_total`) und `solarbank` (`charge_total`, `discharge_total`). Abfrage alle 5 Minuten pro Standort (Cloud-Limit 10–12/min).
- HomeFlow bildet daraus fortlaufende Zähler: Summe der abgeschlossenen Tage seit dem ersten Start plus Tageswert. Die Zähler starten bei 0, nicht beim Zählerstand des Netzbetreibers. Gespeichert in `/data/anker-energy.json`.
- Tage, an denen das Plugin nicht lief, werden nicht nachgeholt. Der Tageswechsel richtet sich nach Europe/Berlin.
- HCU-Semantik `energyCounter`: Smart Meter `in` = Einspeisung, `out` = Netzbezug. Solarbank `in` = Ladung, `out` = Entladung.
- Die Feldnamen stammen aus der Bibliothek und sind an einem echten Gerät **nicht verifiziert**. Ob das HCU-Energie-Dashboard diese Zähler anzeigt, ist ebenfalls ungeprüft.

## Rollladen-Automatik (Sonnenuntergang + Helligkeit)

Regel `shutter-sunset` (`src/automation/shutter-sunset.ts`): Der Rollladen schließt einmal pro Tag zum Zeitpunkt `Sonnenuntergang + baseOffsetMinutes + Helligkeitsverschiebung`.

- Die Helligkeit (Lux, gleitender Mittelwert über `smoothingMinutes`) verschiebt die Zeit linear: ab `brightLux` um `lateMinutes` später (sonniger Sommerabend), bei `darkLux` oder darunter um `earlyMinutes` früher (bewölkt). Ohne frischen Sensorwert gilt der neutrale Offset (Standard +15 min).
- Die Zeit liegt dadurch immer in `[Sonnenuntergang + base − early, Sonnenuntergang + base + late]`. Standard: 15 / 60 / 30 min, 100 / 1000 lx. Die Lux-Schwellen sind Schätzwerte und müssen mit echten Messwerten der Wetterstation abgestimmt werden.
- Standort und Zeitzone kommen aus dem HCU-Systemzustand (`home.location`, `home.timeZoneId`), nicht aus einer eigenen Konfiguration.
- Das Plugin liest per Connect API (`/hmip/home/getSystemState` plus `HMIP_SYSTEM_EVENT`) Wetterstation und Rollläden und steuert über `/hmip/device/control/setShutterLevel`. HomeFlow-IDs: `hcu:<HCU-Geräte-ID>:<Kanalindex>`; sie stehen beim Start im Log („HCU device found“). Helligkeit wird aus `averageIllumination`, `illumination` oder `currentIllumination` des Kanals gelesen – **die Feldnamen der HmIP-SWO-PRO sind nicht an echtem Gerät verifiziert**. `shutterLevel` 1.0 = geschlossen (HmIP-Konvention).
- **Ein/Aus in der App:** Das Plugin bietet den virtuellen Schalter „Rollladen-Automatik“ (`automation:shutter-sunset`) an. Nach der Geräte-Suche im Plugin in der Homematic-IP-App hinzufügen (INCLUSION); der Schalter schaltet die Automatik an/aus. Der Zustand wird in `/data/automation-switches.json` gespeichert und überlebt Neustarts (Standard beim ersten Start: an). Ob die App den Schalter wie erwartet darstellt, ist nicht an echter HCU verifiziert.
- **Verwaltung in HCUweb** (Plugin → Konfiguration, Bereich „Rollladen-Automatik: Einstellungen“): Automatik an/aus, Basis-Minuten nach Sonnenuntergang, max. früher/später, Dunkel-/Hell-Schwellen in Lux, Mittelungsdauer und Helligkeitssensor (bei nur einem Sensor automatisch). Zusätzlich werden die geplante Schließzeit und die aktuelle Helligkeit schreibgeschützt angezeigt (Stand: beim Öffnen/Neuladen der Seite). Nach dem Schließen zeigt die Seite „heute erledigt“ und die Zeit für morgen (ohne Helligkeitsverschiebung). Hat ein Wetter-Kanal kein bekanntes Helligkeitsfeld, loggt das Plugin einmalig dessen numerische Felder („has no known brightness field“), um den echten Feldnamen zu finden. Ungültige Werte (z. B. Dunkel ≥ Hell) werden mit Fehlermeldung abgelehnt, nichts wird dann übernommen. Gespeichert in `/data/shutter-settings.json`.
- `/data/shutter-sunset.json` ist nur noch optional (Startwerte). Ohne Rollladen-Auswahl passiert nichts: die Safety-Policy erlaubt ausschließlich ausgewählte Rollläden/Gruppen.
- **Auswahl der Rollläden/Beschattungsgruppen:** In HCUweb (Plugin → Konfiguration, Bereich „Rollladen-Automatik“) erscheint pro gefundenem Rollladen und pro Beschattungsgruppe eine Checkbox (Connect API kennt kein Mehrfach-Auswahlfeld). Die Auswahl wird in `/data/shutter-selection.json` gespeichert; solange sie nie gespeichert wurde, gilt `shutterDeviceIds` aus der Config. Ein Rollladen und seine Gruppe sollten nicht gleichzeitig gewählt werden. Eine Gruppe wird über `/hmip/group/switching/setPrimaryShadingLevel` gesteuert (ID `hcu-group:<Gruppen-ID>`); als Beschattungsgruppe gilt eine `SWITCHING`-Gruppe, deren Kanäle alle Rollläden sind – **nicht an echter HCU verifiziert**. Die Liste füllt sich erst nach dem Laden des Systemzustands (Konfigurationsseite ggf. neu laden). Die Anker-Einstellungen stehen auf derselben Seite.
- Aktivierung der Konfiguration über `/data/shutter-sunset.json`; ohne Datei bleibt jede Steuerung gesperrt. Die Safety-Policy erlaubt nur `shutter_level` der gelisteten Rollläden. Nach Erfolg wird der Tag in `/data/automation-state.json` vermerkt (kein erneutes Schließen nach manuellem Öffnen oder Neustart); bei Fehlern gibt es bis zu 5 Versuche pro Tag. Bereits geschlossene Rollläden werden nicht angefahren.

```json
{
  "enabled": true,
  "shutterDeviceIds": ["hcu:3014F711A0000000000001:1"],
  "sensorDeviceId": "hcu:3014F711A0000000000002:1",
  "baseOffsetMinutes": 15,
  "earlyMinutes": 60,
  "lateMinutes": 30,
  "darkLux": 100,
  "brightLux": 1000
}
```
