import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { roundToStep } from '../src/climate.js';
import { ClimateFanMode, ClimateMode, ClimatePreset, ClimateSwingMode, type ClimateCommand, type ClimateConfig, type ClimateState } from '../src/esphome.js';

/** Traits and entities recorded from a real SLWF-01pro (firmware 2.1, ESPHome 2024.4.2). */
export const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/slwf-01pro-2.1.json', import.meta.url), 'utf8'),
) as {
  climateConfig: ClimateConfig;
  climateStates: ClimateState[];
  entities: Array<{ type: string; config: { objectId: string; deviceClass?: string }; state?: unknown }>;
};

export const traits: ClimateConfig = fixture.climateConfig;

export function climateState(overrides: Partial<ClimateState> = {}): ClimateState {
  return {
    key: traits.key,
    mode: ClimateMode.Heat,
    action: 0,
    currentTemperature: 22.5,
    targetTemperature: 21,
    fanMode: ClimateFanMode.Auto,
    customFanMode: '',
    swingMode: ClimateSwingMode.Vertical,
    preset: ClimatePreset.None,
    customPreset: '',
    ...overrides,
  };
}

/** iOS converts a °F choice to Celsius before sending it. */
export const fahrenheitToCelsius = (f: number) => (f - 32) * 5 / 9;
export const celsiusToFahrenheit = (c: number) => c * 9 / 5 + 32;

/**
 * What this AC (set to display °F) does with a setpoint: it keeps whole °F and
 * reports the nearest 0.5 °C. Observed: 21.5→21.5, 22→22, 22.5→23 (72.5 °F rounds up).
 */
export function acSettledSetpoint(sentCelsius: number): number {
  const fahrenheit = Math.round(celsiusToFahrenheit(roundToStep(sentCelsius, 0.5)));
  return roundToStep(fahrenheitToCelsius(fahrenheit), 0.5);
}

/**
 * Stands in for AcDevice. `apply()` mimics the real AC: applies a command the way
 * the hardware did in testing, including rejecting swing changes in Heat.
 */
export class FakeDevice extends EventEmitter {
  available = false;
  climateConfig: ClimateConfig | null = null;
  climateState: ClimateState | null = null;
  deviceInfo = null;
  readonly entities = new Map<string, { type: string; config: { objectId: string; deviceClass?: string } }>();
  readonly entityStates = new Map<string, number | boolean | string>();
  readonly commands: ClimateCommand[] = [];
  sendResult = true;

  sendClimateCommand = vi.fn((command: ClimateCommand) => {
    if (!this.available) {
      return false;
    }
    this.commands.push(command);
    return this.sendResult;
  });

  /** Connect: report traits, entities, and a first state. */
  connect(state: ClimateState = climateState()): void {
    this.climateConfig = traits;
    this.emit('climateConfig', traits);
    for (const entity of fixture.entities) {
      this.entities.set(entity.config.objectId, entity);
    }
    this.report(state);
  }

  report(state: ClimateState): void {
    this.climateState = state;
    if (!this.available) {
      this.available = true;
      this.emit('availability', true);
    }
    this.emit('climateState', state);
  }

  disconnect(): void {
    this.available = false;
    this.emit('availability', false);
  }

  /** Report the state the real AC ends up in after `command`. */
  apply(command: ClimateCommand): void {
    const state = { ...this.climateState! };
    if (command.mode !== undefined) {
      state.mode = command.mode;
    }
    if (command.targetTemperature !== undefined) {
      state.targetTemperature = acSettledSetpoint(command.targetTemperature);
    }
    if (command.fanMode !== undefined) {
      state.fanMode = command.fanMode;
      state.customFanMode = '';
    }
    if (command.swingMode !== undefined && state.mode !== ClimateMode.Heat) {
      state.swingMode = command.swingMode;
    }
    if (command.preset !== undefined) {
      state.preset = command.preset;
    }
    this.report(state);
  }

  lastCommand(): ClimateCommand | undefined {
    return this.commands[this.commands.length - 1];
  }

  setEntityState(objectId: string, value: number | boolean | string): void {
    this.entityStates.set(objectId, value);
    this.emit('entityState', objectId, value);
  }
}
