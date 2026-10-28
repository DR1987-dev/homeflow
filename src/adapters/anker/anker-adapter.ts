import type { CapabilityReading, DeviceCommand, DeviceDefinition } from "../../domain/device.js";
import type { DeviceAdapter } from "../device-adapter.js";
import type { AnkerCloudClient, AnkerSolarbank } from "./anker-cloud-client.js";

export const ANKER_ADAPTER_ID = "anker-cloud";

const CACHE_MS = 30_000;

/** Read-only adapter for Anker Solix Solarbanks via the unofficial cloud API. */
export class AnkerCloudAdapter implements DeviceAdapter {
  readonly id = ANKER_ADAPTER_ID;
  private cache: { at: number; banks: AnkerSolarbank[] } | undefined;

  constructor(
    private readonly client: Pick<AnkerCloudClient, "fetchSolarbanks">,
    private readonly now: () => number = Date.now,
  ) {}

  async discover(): Promise<readonly DeviceDefinition[]> {
    const banks = await this.banks(true);
    return banks.map((bank) => ({
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
  }

  async readState(id: string): Promise<readonly CapabilityReading[]> {
    const banks = await this.banks(false);
    const bank = banks.find((candidate) => deviceId(candidate.sn) === id);
    if (!bank) {
      throw new Error(`Solarbank "${id}" was not found in the Anker account.`);
    }
    const observedAt = new Date(this.cache?.at ?? this.now()).toISOString();
    const values: [string, number | undefined][] = [
      ["battery_level", bank.stateOfChargePercent],
      ["pv_power_w", bank.photovoltaicPowerW],
      ["output_power_w", bank.outputPowerW],
    ];
    return values.flatMap(([capabilityId, value]) =>
      value === undefined ? [] : [{ capabilityId, value, observedAt }],
    );
  }

  async execute(command: DeviceCommand): Promise<void> {
    throw new Error(`The Anker adapter is read-only; "${command.capabilityId}" cannot be set.`);
  }

  private async banks(force: boolean): Promise<AnkerSolarbank[]> {
    if (!force && this.cache && this.now() - this.cache.at < CACHE_MS) {
      return this.cache.banks;
    }
    const banks = await this.client.fetchSolarbanks();
    this.cache = { at: this.now(), banks };
    return banks;
  }
}

function deviceId(serial: string): string {
  return `anker-${serial.toLowerCase()}`;
}
