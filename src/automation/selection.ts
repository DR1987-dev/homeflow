import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DeviceDefinition } from "../domain/device.js";
import { SHUTTER_LEVEL } from "./shutter-sunset.js";

const PREFIX = "shutter:";

export const isPropertyOfSelection = (key: string) => key.startsWith(PREFIX);

/**
 * Which shutters and shading groups the automation closes. The HCU configuration page has no multi-select,
 * so every candidate is offered as its own checkbox. Selections of devices that are not currently known are kept.
 */
export class ShutterSelection {
  private selected: Set<string>;

  constructor(
    private readonly options: {
      file: string;
      initial: readonly string[];
      candidates: () => readonly DeviceDefinition[];
    },
  ) {
    this.selected = new Set(options.initial);
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.options.file, "utf8")) as unknown;
      if (Array.isArray(saved)) {
        this.selected = new Set(saved.filter((id): id is string => typeof id === "string"));
      }
    } catch {
      // No saved selection: the initial list from the configuration file applies.
    }
  }

  get ids(): readonly string[] {
    return [...this.selected];
  }

  private candidates(): DeviceDefinition[] {
    return this.options
      .candidates()
      .filter((device) =>
        device.capabilities.some((c) => c.id === SHUTTER_LEVEL && c.writable),
      );
  }

  template() {
    const candidates = this.candidates();
    return {
      groups: {
        shutters: {
          friendlyName: "Rollladen-Automatik",
          description:
            candidates.length === 0
              ? "Noch keine Rollläden oder Beschattungsgruppen gefunden. Seite nach dem Start des Plugins neu laden."
              : "Auswahl der Rollläden und Beschattungsgruppen, die bei Sonnenuntergang geschlossen werden. Eine Gruppe und ihre Mitglieder nicht gleichzeitig wählen.",
          order: 2,
        },
      },
      properties: Object.fromEntries(
        candidates.map((device, index) => [
          `${PREFIX}${device.id}`,
          {
            dataType: "BOOLEAN",
            friendlyName: device.name,
            groupId: "shutters",
            order: 100 + index,
            currentValue: String(this.selected.has(device.id)),
          },
        ]),
      ),
    };
  }

  /** Applies the checkbox values and persists them; returns the number of selected devices. */
  async update(properties: Record<string, unknown>): Promise<number> {
    const known = new Set(this.candidates().map((device) => device.id));
    for (const [key, value] of Object.entries(properties)) {
      if (!isPropertyOfSelection(key) || typeof value !== "boolean") continue;
      const id = key.slice(PREFIX.length);
      if (!known.has(id)) continue;
      if (value) {
        this.selected.add(id);
      } else {
        this.selected.delete(id);
      }
    }
    await mkdir(dirname(this.options.file), { recursive: true });
    await writeFile(this.options.file, JSON.stringify([...this.selected]), "utf8");
    return this.selected.size;
  }
}
