import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActionContext, ActionSafetyPolicy } from "../actions/action-dispatcher.js";
import type { RunStore } from "./engine.js";

type Pair = { deviceId: string; capabilityId: string };

/** Permits only the listed device/capability pairs; everything else stays blocked. */
export class AllowListSafetyPolicy implements ActionSafetyPolicy {
  private readonly pairs: () => readonly Pair[];

  constructor(pairs: readonly Pair[] | (() => readonly Pair[])) {
    this.pairs = typeof pairs === "function" ? pairs : () => pairs;
  }

  authorize({ command }: ActionContext): void {
    const allowed = this.pairs().some(
      (pair) => pair.deviceId === command.deviceId && pair.capabilityId === command.capabilityId,
    );
    if (!allowed) {
      throw new Error(
        `Control of ${command.deviceId}/${command.capabilityId} is not permitted by the safety policy.`,
      );
    }
  }
}

/** Remembers the last local day each rule completed, so a restart does not repeat it. */
export class FileRunStore implements RunStore {
  private days: Record<string, string> = {};

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      this.days = JSON.parse(await readFile(this.file, "utf8")) as Record<string, string>;
    } catch {
      this.days = {};
    }
  }

  get(ruleId: string): string | undefined {
    return this.days[ruleId];
  }

  async set(ruleId: string, dayKey: string): Promise<void> {
    this.days[ruleId] = dayKey;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.days), "utf8");
  }
}
