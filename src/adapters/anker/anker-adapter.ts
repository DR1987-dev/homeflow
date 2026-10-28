import type { CapabilityReading, DeviceCommand, DeviceDefinition } from "../../domain/device.js";
import type { DeviceAdapter } from "../device-adapter.js";
import type { AnkerCloudClient, AnkerSmartMeter, AnkerSnapshot } from "./anker-cloud-client.js";

export const ANKER_ADAPTER_ID = "anker-cloud";

const CACHE_MS = 30_000;

/** Read-only adapter for Anker Solix Solarbanks via the unofficial cloud API. */
export class AnkerCloudAdapter implements DeviceAdapter {
  readonly id = ANKER_ADAPTER_ID;
  private cache: { at: number; snapshot: AnkerSnapshot } | undefined;

  constructor(
    private readonly client: Pick<AnkerCloudClient, "fetchSnapshot">,
    private readonly now: () => number = Date.now,
  ) {}

  async discover(): Promise<readonly DeviceDefinition[]> {
    const { solarbanks, meters } = await this.snapshot(true);
    const banks: DeviceDefinition[] = solarbanks.map((bank) => ({
      id: deviceId(bank.sn),
      adapterId: this.id,
      manufacturer: "Anker",
      model: bank.model,
      name: bank.name,
      kind: "battery",
      capabilities: [
        { id: "battery_level", label: "Ladestand", type: "number", unit: "%", min: 0, max: 100, readable: true, writable: false },
        { id: "pv_power_w", label: "Solarleistung", type: "number", unit: "W", readable: true, writable: false },
        { id: "output_power_w", label: "Ausgangsleistung", type: "number", unit: "W", readable: true, writable: false },
      ],
    }));
    const meterDefinitions: DeviceDefinition[] = meters.map((meter) => ({
      id: deviceId(meter.sn),
      adapterId: this.id,
      manufacturer: "Anker",
      model: meter.model,
      name: meter.name,
      kind: "energy-meter",
      capabilities: [
        { id: "power_w", label: "Netzleistung (Bezug +, Einspeisung -)", type: "number", unit: "W", readable: true, writable: false },
        { id: "grid_import_w", label: "Netzbezug", type: "number", unit: "W", readable: true, writable: false },
        { id: "grid_export_w", label: "Einspeisung", type: "number", unit: "W", readable: true, writable: false },
      ],
    }));
    return [...banks, ...meterDefinitions];
  }

  async readState(id: string): Promise<readonly CapabilityReading[]> {
    const { solarbanks, meters } = await this.snapshot(false);
    const bank = solarbanks.find((candidate) => deviceId(candidate.sn) === id);
    const meter = meters.find((candidate) => deviceId(candidate.sn) === id);
    if (!bank && !meter) {
      throw new Error(`Device "${id}" was not found in the Anker account.`);
    }
    const observedAt = new Date(this.cache?.at ?? this.now()).toISOString();
    const values: [string, number | undefined][] = bank
      ? [
          ["battery_level", bank.stateOfChargePercent],
          ["pv_power_w", bank.photovoltaicPowerW],
          ["output_power_w", bank.outputPowerW],
        ]
      : meterValues(meter!);
    return values.flatMap(([capabilityId, value]) =>
      value === undefined ? [] : [{ capabilityId, value, observedAt }],
    );
  }

  async execute(command: DeviceCommand): Promise<void> {
    throw new Error(`The Anker adapter is read-only; "${command.capabilityId}" cannot be set.`);
  }

  private async snapshot(force: boolean): Promise<AnkerSnapshot> {
    if (!force && this.cache && this.now() - this.cache.at < CACHE_MS) {
      return this.cache.snapshot;
    }
    const snapshot = await this.client.fetchSnapshot();
    this.cache = { at: this.now(), snapshot };
    return snapshot;
  }
}

function deviceId(serial: string): string {
  return `anker-${serial.toLowerCase()}`;
}

function meterValues(meter: AnkerSmartMeter): [string, number | undefined][] {
  return [
    ["power_w", meter.gridPowerW],
    ["grid_import_w", meter.importPowerW],
    ["grid_export_w", meter.exportPowerW],
  ];
}
