# HomeFlow

HomeFlow ist als modulare TypeScript-Plattform für Smart Home, Energie und Automatisierung angelegt. Integrationen bilden Geräte und Protokolle ab; sie enthalten keine Automatisierungsregeln oder UI-Logik.

## Aktueller Stand

Dieses erste Inkrement enthält:

- ein einheitliches Geräte- und dynamisches Fähigkeitsmodell
- eine Device Registry und eine Adapter Registry
- Schnittstellen für Geräteerkennung, Zustandsabruf und Befehle
- einen typisierten In-Memory-Event-Bus
- einen Action Dispatcher, der Fähigkeiten, Wertebereiche und eine verpflichtende Safety-/Berechtigungsrichtlinie prüft
- Tests für Registry, Event-Bus und Aktionsgrenzen

Noch nicht implementiert sind persistente Speicherung, konkrete Geräteadapter, Scheduler, Automatisierungsregeln, History/Audit-Speicherung und eine externe API. Dafür werden keine Microservices vorausgesetzt.

## Entwicklung

Voraussetzung ist Node.js 22 oder neuer.

```sh
npm install
npm test
npm run typecheck
npm run test:watch
```

`npm test` führt die Tests lokal aus; `npm run typecheck` prüft die strikten TypeScript-Typen; `npm run build` erzeugt `dist/`. Das Docker-Image (`Dockerfile`) und das HCU1-Plugin-Image (`Dockerfile.hcu`, ARM64) werden in GitHub Actions gebaut, siehe [docs/integrations.md](./docs/integrations.md). Die Module verwenden zunächst In-Memory-Implementierungen und benötigen zur Entwicklung weder HCU1 noch FRITZ!Box oder Hersteller-Cloud.

## Modulgrenzen

| Modul | Verantwortung | Status |
|---|---|---|
| `domain` | Herstellerneutrale Geräte, Fähigkeiten und Werte | Basis vorhanden |
| `registry` | Geräteidentitäten und registrierte Fähigkeiten | In-Memory-Basis vorhanden |
| `adapters` | Hersteller-/Protokolladapter mit stabilem Vertrag | Vertrag vorhanden |
| `events` | Zustands- und Verfügbarkeitsereignisse | In-Memory-Basis vorhanden |
| `actions` | Zentral geprüfte Befehlsausführung | Dispatch-Grenze vorhanden |
| `automation` | Regeln, Engine (Tick-basiert, einmal pro Tag) und Allowlist-Safety | Basis vorhanden; erste Regel: Rollladen bei Sonnenuntergang |
| `astro` | Sonnenuntergang (NOAA-Formeln) | Vorhanden |
| `scheduler` | Zeitgesteuerte Auslöser | Minutentakt in der Automation-Engine; eigener Scheduler geplant |
| `safety` | Rechte, Grenzen, manuelle Übersteuerung und Richtlinien | Schnittstelle vorhanden; Richtlinienimplementierung geplant |
| `history` | Verlauf und revisionsfähiges Audit | Geplant |
| `api` | Externe Clients, später REST/WebSocket | Geplant |
| `energy` | Energie- und Tariflogik | Geplant |

Die Integrationsrecherche und die Grenzen der konkret genannten Geräte stehen in [docs/integrations.md](./docs/integrations.md).
