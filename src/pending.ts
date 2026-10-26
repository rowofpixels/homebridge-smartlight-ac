import { applyCommand, unconfirmedFields } from './climate.js';
import type { ClimateCommand, ClimateState } from './esphome.js';

type Field = keyof ClimateCommand;
type Value = number | string;

// Setting a standard fan mode clears a custom one and vice versa; the same goes for presets.
const COUNTERPART: Partial<Record<Field, Field>> = {
  fanMode: 'customFanMode',
  customFanMode: 'fanMode',
  preset: 'customPreset',
  customPreset: 'preset',
};

export interface ExpiredField {
  field: Field;
  requested: Value;
}

/**
 * Command fields sent to the device but not yet reflected in its reported state.
 *
 * The AC takes about 1–3 s to confirm a change. Until then HomeKit should keep
 * showing what was requested, so unrelated state updates (like a temperature
 * reading) don't flip the UI back. A field the device still hasn't applied by
 * its deadline is dropped, and from then on the device's value wins.
 */
export class PendingCommands {
  private readonly fields = new Map<Field, { value: Value; deadline: number }>();

  constructor(private readonly timeoutMs: number) {}

  get size(): number {
    return this.fields.size;
  }

  add(command: ClimateCommand, now: number): void {
    for (const [field, value] of Object.entries(command) as Array<[Field, Value | undefined]>) {
      if (value === undefined) {
        continue;
      }
      this.fields.set(field, { value, deadline: now + this.timeoutMs });
      const counterpart = COUNTERPART[field];
      if (counterpart) {
        this.fields.delete(counterpart);
      }
    }
  }

  /** `state` as it will be once the pending fields are applied. */
  apply(state: ClimateState): ClimateState {
    const command: Record<string, Value> = {};
    for (const [field, { value }] of this.fields) {
      command[field] = value;
    }
    return applyCommand(state, command as ClimateCommand);
  }

  /**
   * Forget fields that `state` confirms, and fields whose deadline has passed.
   * Returns the ones that expired without being confirmed.
   */
  settle(state: ClimateState, now: number): ExpiredField[] {
    const expired: ExpiredField[] = [];
    for (const [field, { value, deadline }] of this.fields) {
      if (unconfirmedFields({ [field]: value }, state).length === 0) {
        this.fields.delete(field);
      } else if (now >= deadline) {
        this.fields.delete(field);
        expired.push({ field, requested: value });
      }
    }
    return expired;
  }

  /** When the earliest pending field expires, if any. */
  nextDeadline(): number | undefined {
    let next: number | undefined;
    for (const { deadline } of this.fields.values()) {
      next = next === undefined ? deadline : Math.min(next, deadline);
    }
    return next;
  }

  clear(): void {
    this.fields.clear();
  }
}
