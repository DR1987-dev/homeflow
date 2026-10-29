import type { CapabilityReading, DeviceCommand, DeviceDefinition } from "../../domain/device.js";
import type { DeviceAdapter } from "../device-adapter.js";
import type { AnkerCloudClient, AnkerSmartMeter, AnkerSnapshot } from "./anker-cloud-client.js";
import type { EnergyCounters } from "./energy-counter.js";

export const ANKER_ADAPTER_ID = "anker-cloud";

const CACHE_MS = 30_000;
const ENERGY_CACHE_MS = 5 * 60_000;

/** Read-only adapter for Anker Solix Solarbanks via the unofficial cloud API. */
export class AnkerCloudAdapter implements DeviceAdapter {
  readonly id = ANKER_ADAPTER_ID;
  private cache: { at: number; snapshot: AnkerSnapshot } | undefined;

  constructor(
    private readonly client: Pick<AnkerCloudClient, "fetchSnapshot">,
    private readonly now: () => number = Date.now,
    private readonly energy?: EnergyCounters,
    private readonly log?: (line: string) => void,
  ) {}

  private readonly energyCache = new Map<string, { at: number; counters: Awaited<ReturnType<EnergyCounters["refresh"]>> }>();

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
        ...(this.energy ? [kwh("energy_in_kwh", "Geladene Energie"), kwh("energy_out_kwh", "Entladene Energie")] : []),
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
        ...(this.energy ? [kwh("energy_in_kwh", "Eingespeiste Energie"), kwh("energy_out_kwh", "Bezogene Energie")] : []),
      ],
    }));
    // The HCU has no PV feature on a battery, so the PV side is its own inverter device.
    const pvDefinitions: DeviceDefinition[] = solarbanks.map((bank) => ({
      id: pvDeviceId(bank.sn),
      adapterId: this.id,
      manufacturer: "Anker",
      model: bank.model,
      name: `${bank.name} PV`,
      kind: "inverter",
      capabilities: [
        { id: "power_w", label: "Solarleistung", type: "number", unit: "W", readable: true, writable: false },
      ],
    }));
    return [...banks, ...pvDefinitions, ...meterDefinitions];
  }

  async readState(id: string): Promise<readonly CapabilityReading[]> {
    const { solarbanks, meters } = await this.snapshot(false);
    const pvBank = solarbanks.find((candidate) => pvDeviceId(candidate.sn) === id);
    if (pvBank) {
      const observedAt = new Date(this.cache?.at ?? this.now()).toISOString();
      return pvBank.photovoltaicPowerW === undefined
        ? []
        : [{ capabilityId: "power_w", value: pvBank.photovoltaicPowerW, observedAt }];
    }
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
    const siteId = (bank ?? meter!).siteId;
    const counters = await this.counters(siteId, (bank ?? meter!).sn);
    // HCU semantics: "in" flows into the device, "out" flows from the device to the home.
    const energyValues: [string, number | undefined][] = bank
      ? [["energy_in_kwh", counters?.batteryChargeKwh], ["energy_out_kwh", counters?.batteryDischargeKwh]]
      : [["energy_in_kwh", counters?.gridExportKwh], ["energy_out_kwh", counters?.gridImportKwh]];
    values.push(...energyValues);
    return values.flatMap(([capabilityId, value]) =>
      value === undefined ? [] : [{ capabilityId, value, observedAt }],
    );
  }

  async execute(command: DeviceCommand): Promise<void> {
    throw new Error(`The Anker adapter is read-only; "${command.capabilityId}" cannot be set.`);
  }

  private async counters(siteId: string, sn: string) {
    if (!this.energy) {
      return undefined;
    }
    const cached = this.energyCache.get(siteId);
    if (cached && this.now() - cached.at < ENERGY_CACHE_MS) {
      return cached.counters;
    }
    try {
      const counters = await this.energy.refresh(siteId, sn);
      this.energyCache.set(siteId, { at: this.now(), counters });
      return counters;
    } catch (error) {
      this.log?.(`Anker energy statistics failed: ${error instanceof Error ? error.message : String(error)}`);
      // Energy statistics are rate limited and optional; power values stay available.
      this.energyCache.set(siteId, { at: this.now(), counters: cached?.counters ?? {} });
      return cached?.counters;
    }
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

function pvDeviceId(serial: string): string {
  return `anker-${serial.toLowerCase()}-pv`;
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

function kwh(id: string, label: string): DeviceDefinition["capabilities"][number] {
  return { id, label, type: "number", unit: "kWh", readable: true, writable: false };
}
