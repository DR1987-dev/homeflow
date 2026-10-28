import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AnkerDailyEnergy } from "./anker-cloud-client.js";

type Metric = keyof AnkerDailyEnergy;
const METRICS: Metric[] = ["gridImportKwh", "gridExportKwh", "batteryChargeKwh", "batteryDischargeKwh"];

interface SiteState {
  date: string;
  baseline: Partial<Record<Metric, number>>;
  today: Partial<Record<Metric, number>>;
}

export type EnergyFetcher = (siteId: string, deviceSn: string, date: string) => Promise<AnkerDailyEnergy>;

/**
 * Turns the daily Anker statistics into continuously increasing kWh counters:
 * counter = sum of finished days since first start + today's value. Counters start at 0.
 */
export class EnergyCounters {
  private readonly sites = new Map<string, SiteState>();
  private loaded = false;

  constructor(
    private readonly fetchDay: EnergyFetcher,
    private readonly options: { file?: string; timeZone?: string; now?: () => number } = {},
  ) {}

  async refresh(siteId: string, deviceSn: string): Promise<Partial<Record<Metric, number>>> {
    await this.load();
    const today = this.dateOf(this.options.now?.() ?? Date.now());
    let state = this.sites.get(siteId);

    if (state && state.date !== today) {
      // Close the previous day with its final values. Days skipped while the plugin was off are not recovered.
      const final = await this.fetchDay(siteId, deviceSn, state.date).catch(() => undefined);
      for (const metric of METRICS) {
        const done = final?.[metric] ?? state.today[metric];
        if (done !== undefined) {
          state.baseline[metric] = (state.baseline[metric] ?? 0) + done;
        }
      }
      state = undefined;
    }

    const day = await this.fetchDay(siteId, deviceSn, today);
    const baseline = state?.baseline ?? this.sites.get(siteId)?.baseline ?? {};
    const next: SiteState = { date: today, baseline, today: {} };
    const counters: Partial<Record<Metric, number>> = {};
    for (const metric of METRICS) {
      const value = day[metric];
      if (value !== undefined) {
        next.today[metric] = value;
        counters[metric] = round((baseline[metric] ?? 0) + value);
      }
    }
    this.sites.set(siteId, next);
    await this.save();
    return counters;
  }

  private dateOf(ms: number): string {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: this.options.timeZone ?? "Europe/Berlin" }).format(ms);
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    if (!this.options.file) {
      return;
    }
    try {
      const stored = JSON.parse(await readFile(this.options.file, "utf8")) as Record<string, SiteState>;
      for (const [siteId, state] of Object.entries(stored)) {
        this.sites.set(siteId, state);
      }
    } catch {
      // No or unreadable state: counters start at 0.
    }
  }

  private async save(): Promise<void> {
    if (!this.options.file) {
      return;
    }
    await mkdir(dirname(this.options.file), { recursive: true });
    const temp = `${this.options.file}.tmp`;
    await writeFile(temp, JSON.stringify(Object.fromEntries(this.sites)));
    await rename(temp, this.options.file);
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
