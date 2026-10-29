import type { ActionDispatcher } from "../actions/action-dispatcher.js";
import { dateKey, localDate } from "../astro/sun.js";
import type { DeviceCommand } from "../domain/device.js";
import type { StateStore } from "../state/state-store.js";

export interface GeoLocation {
  latitude: number;
  longitude: number;
  timeZone: string;
}

export interface RuleContext {
  now: Date;
  state: StateStore;
  location: GeoLocation | undefined;
}

export interface Rule {
  id: string;
  /** When this returns false the rule is skipped (observe still runs). */
  isEnabled?(): boolean;
  /** Called on every evaluation, also while the rule is not due, e.g. to collect samples. */
  observe?(context: RuleContext): void;
  /** Returns undefined while the rule is not due, otherwise the commands to run (possibly none). */
  evaluate(context: RuleContext): readonly DeviceCommand[] | undefined;
  /** Run at most once per local calendar day; the day is marked done once all commands succeeded. */
  oncePerDay?: boolean;
}

export interface RunStore {
  get(ruleId: string): string | undefined;
  set(ruleId: string, dayKey: string): void | Promise<void>;
}

export class InMemoryRunStore implements RunStore {
  private readonly days = new Map<string, string>();
  get(ruleId: string) {
    return this.days.get(ruleId);
  }
  set(ruleId: string, dayKey: string) {
    this.days.set(ruleId, dayKey);
  }
}

export interface AutomationEngineOptions {
  rules: readonly Rule[];
  state: StateStore;
  dispatcher: ActionDispatcher;
  runStore: RunStore;
  getLocation: () => GeoLocation | undefined;
  now?: () => Date;
  maxAttemptsPerDay?: number;
  log?: (line: string) => void;
}

export class AutomationEngine {
  private readonly attempts = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: AutomationEngineOptions) {}

  start(intervalMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Evaluates all rules once. Overlapping ticks are skipped. */
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const now = (this.options.now ?? (() => new Date()))();
      const location = this.options.getLocation();
      const context: RuleContext = { now, state: this.options.state, location };
      for (const rule of this.options.rules) {
        await this.run(rule, context);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(rule: Rule, context: RuleContext): Promise<void> {
    const { log, runStore, dispatcher } = this.options;
    try {
      rule.observe?.(context);
      if (rule.isEnabled && !rule.isEnabled()) {
        return;
      }

      const day = dateKey(localDate(context.now, context.location?.timeZone ?? "UTC"));
      if (rule.oncePerDay && runStore.get(rule.id) === day) {
        return;
      }
      const commands = rule.evaluate(context);
      if (commands === undefined) {
        return;
      }
      if (commands.length === 0) {
        if (rule.oncePerDay) {
          await runStore.set(rule.id, day);
        }
        return;
      }

      const attemptKey = `${rule.id}:${day}`;
      const attempt = (this.attempts.get(attemptKey) ?? 0) + 1;
      if (attempt > (this.options.maxAttemptsPerDay ?? 5)) {
        return;
      }
      this.attempts.set(attemptKey, attempt);

      log?.(`Rule "${rule.id}" fires (attempt ${attempt}): ${commands.length} command(s)`);
      let failed = false;
      for (const command of commands) {
        try {
          await dispatcher.dispatch(command);
        } catch (error) {
          failed = true;
          log?.(
            `Rule "${rule.id}": ${command.deviceId}/${command.capabilityId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (!failed && rule.oncePerDay) {
        await runStore.set(rule.id, day);
      }
    } catch (error) {
      log?.(`Rule "${rule.id}" error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
