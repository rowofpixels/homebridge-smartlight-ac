import { describe, expect, it } from 'vitest';
import { ClimateFanMode, ClimateMode, ClimateSwingMode } from '../src/esphome.js';
import { PendingCommands } from '../src/pending.js';
import { climateState } from './helpers.js';

describe('PendingCommands', () => {
  it('shows requested values over the device state until confirmed', () => {
    const pending = new PendingCommands(8000);
    pending.add({ mode: ClimateMode.Cool, targetTemperature: 22 }, 0);

    // An unrelated update (new room temperature) still carries the old mode.
    const stale = climateState({ currentTemperature: 22 });
    expect(pending.settle(stale, 1000)).toEqual([]);
    expect(pending.apply(stale)).toMatchObject({ mode: ClimateMode.Cool, targetTemperature: 22, currentTemperature: 22 });

    // Confirmation clears it.
    pending.settle(climateState({ mode: ClimateMode.Cool, targetTemperature: 22 }), 2000);
    expect(pending.size).toBe(0);
  });

  it('confirms fields independently', () => {
    const pending = new PendingCommands(8000);
    pending.add({ mode: ClimateMode.Cool, swingMode: ClimateSwingMode.Off }, 0);

    pending.settle(climateState({ mode: ClimateMode.Cool }), 1000);
    expect(pending.size).toBe(1);
    expect(pending.apply(climateState()).swingMode).toBe(ClimateSwingMode.Off);
  });

  it('gives up after the deadline and reports what the device did not apply', () => {
    const pending = new PendingCommands(8000);
    pending.add({ swingMode: ClimateSwingMode.Off }, 0);

    expect(pending.nextDeadline()).toBe(8000);
    expect(pending.settle(climateState(), 7999)).toEqual([]);
    expect(pending.settle(climateState(), 8000)).toEqual([{ field: 'swingMode', requested: ClimateSwingMode.Off }]);
    expect(pending.apply(climateState()).swingMode).toBe(ClimateSwingMode.Vertical);
    expect(pending.nextDeadline()).toBeUndefined();
  });

  it('a standard fan mode replaces a pending custom one', () => {
    const pending = new PendingCommands(8000);
    pending.add({ customFanMode: 'silent' }, 0);
    pending.add({ fanMode: ClimateFanMode.High }, 100);

    expect(pending.apply(climateState())).toMatchObject({ fanMode: ClimateFanMode.High, customFanMode: '' });
    expect(pending.size).toBe(1);
  });
});
