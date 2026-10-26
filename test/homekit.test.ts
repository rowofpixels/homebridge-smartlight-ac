import { describe, expect, it } from 'vitest';
import { ClimateFanMode, ClimateMode, ClimatePreset, ClimateSwingMode } from '../src/esphome.js';
import {
  Active,
  CurrentHeaterCoolerState,
  SwingMode,
  TargetHeaterCoolerState,
  fanModeToSpeed,
  homeKitValues,
  manualFanModes,
  resolveCommand,
  speedToFanMode,
  targetStates,
  toDeviceTemperature,
  type Intents,
  type ResolveContext,
} from '../src/homekit.js';
import {
  acSettledSetpoint,
  celsiusToFahrenheit,
  climateState,
  fahrenheitToCelsius,
  traits,
} from './helpers.js';

function resolve(intents: Intents, overrides: Partial<ResolveContext> = {}) {
  return resolveCommand(intents, {
    state: climateState(),
    traits,
    lastHeatCoolMode: ClimateMode.Heat,
    lastOnMode: ClimateMode.Heat,
    swingMode: ClimateSwingMode.Vertical,
    ...overrides,
  });
}

describe('temperatures', () => {
  // Every whole °F the AC's range covers (17–30 °C).
  const fahrenheitRange = Array.from({ length: 86 - 63 + 1 }, (_, i) => 63 + i);

  it.each(fahrenheitRange)('%i°F chosen in Home lands on %i°F at the AC and shows back as the same', (f) => {
    for (const sent of [fahrenheitToCelsius(f), Math.round(fahrenheitToCelsius(f) * 10) / 10]) {
      const deviceTarget = toDeviceTemperature(sent, traits);
      // The AC keeps the value as-is (no drift to a neighbouring °F)...
      expect(acSettledSetpoint(deviceTarget)).toBe(deviceTarget);
      // ...and Home, showing whole °F, displays what was chosen.
      expect(Math.round(celsiusToFahrenheit(deviceTarget))).toBe(f);
    }
  });

  it('rounds to the 0.5 °C step and clamps to the device range', () => {
    expect(toDeviceTemperature(22.3, traits)).toBe(22.5);
    expect(toDeviceTemperature(22.2, traits)).toBe(22);
    expect(toDeviceTemperature(10, traits)).toBe(17);
    expect(toDeviceTemperature(35, traits)).toBe(30);
  });
});

describe('targetStates', () => {
  it('offers Heat and Cool but not Auto, even though the device lists HEAT_COOL', () => {
    expect(traits.supportedModesList).toContain(ClimateMode.HeatCool);
    expect(targetStates(traits)).toEqual([TargetHeaterCoolerState.HEAT, TargetHeaterCoolerState.COOL]);
  });

  it('offers only Cool for a cool-only unit', () => {
    expect(targetStates({ ...traits, supportedModesList: [ClimateMode.Off, ClimateMode.Cool] }))
      .toEqual([TargetHeaterCoolerState.COOL]);
  });
});

describe('fan speed', () => {
  const modes = manualFanModes(traits);

  it('uses the manual fan modes the device supports', () => {
    expect(modes).toEqual([ClimateFanMode.Low, ClimateFanMode.Medium, ClimateFanMode.High]);
  });

  it('maps Auto to 0% and Low/Medium/High to even stops', () => {
    expect(fanModeToSpeed(ClimateFanMode.Auto, modes)).toBe(0);
    expect(fanModeToSpeed(ClimateFanMode.Low, modes)).toBeCloseTo(33.33, 1);
    expect(fanModeToSpeed(ClimateFanMode.Medium, modes)).toBeCloseTo(66.67, 1);
    expect(fanModeToSpeed(ClimateFanMode.High, modes)).toBe(100);
  });

  it('round-trips every stop', () => {
    for (const mode of [ClimateFanMode.Auto, ...modes]) {
      expect(speedToFanMode(fanModeToSpeed(mode, modes), modes)).toBe(mode);
    }
  });

  it('maps in-between speeds to the nearest stop, and any non-zero speed to at least Low', () => {
    expect(speedToFanMode(1, modes)).toBe(ClimateFanMode.Low);
    expect(speedToFanMode(50, modes)).toBe(ClimateFanMode.Medium);
    expect(speedToFanMode(84, modes)).toBe(ClimateFanMode.High);
  });
});

describe('homeKitValues', () => {
  it('reports Heat as HEAT, and heating while below the setpoint', () => {
    const values = homeKitValues(climateState({ currentTemperature: 20, targetTemperature: 21 }), traits, ClimateMode.Cool);
    expect(values.active).toBe(Active.ACTIVE);
    expect(values.targetState).toBe(TargetHeaterCoolerState.HEAT);
    expect(values.currentState).toBe(CurrentHeaterCoolerState.HEATING);
  });

  it('reports idle in Heat at or above the setpoint (the device never reports its action)', () => {
    expect(traits.supportsAction).toBe(false);
    const values = homeKitValues(climateState({ currentTemperature: 22.5, targetTemperature: 21 }), traits, ClimateMode.Heat);
    expect(values.currentState).toBe(CurrentHeaterCoolerState.IDLE);
  });

  it('reports cooling in Cool above the setpoint', () => {
    const values = homeKitValues(
      climateState({ mode: ClimateMode.Cool, currentTemperature: 25, targetTemperature: 22 }), traits, ClimateMode.Heat);
    expect(values.targetState).toBe(TargetHeaterCoolerState.COOL);
    expect(values.currentState).toBe(CurrentHeaterCoolerState.COOLING);
  });

  it('reports Off as inactive', () => {
    const values = homeKitValues(climateState({ mode: ClimateMode.Off }), traits, ClimateMode.Heat);
    expect(values.active).toBe(Active.INACTIVE);
    expect(values.currentState).toBe(CurrentHeaterCoolerState.INACTIVE);
  });

  it('shows Dry via its switch, keeping the last heat/cool mode as the target state', () => {
    const values = homeKitValues(climateState({ mode: ClimateMode.Dry }), traits, ClimateMode.Cool);
    expect(values.active).toBe(Active.ACTIVE);
    expect(values.targetState).toBe(TargetHeaterCoolerState.COOL);
    expect(values.modeSwitches.get(ClimateMode.Dry)).toBe(true);
    expect(values.modeSwitches.get(ClimateMode.FanOnly)).toBe(false);
  });

  it('shows Midea Auto (set from the remote) as the last heat/cool mode, heating or cooling by temperature', () => {
    const values = homeKitValues(
      climateState({ mode: ClimateMode.HeatCool, currentTemperature: 25, targetTemperature: 22 }), traits, ClimateMode.Heat);
    expect(values.targetState).toBe(TargetHeaterCoolerState.HEAT);
    expect(values.currentState).toBe(CurrentHeaterCoolerState.COOLING);
  });

  it('shows the single setpoint on both thresholds, clamped to the range', () => {
    expect(homeKitValues(climateState({ targetTemperature: 24 }), traits, ClimateMode.Heat).threshold).toBe(24);
    expect(homeKitValues(climateState({ targetTemperature: 8 }), traits, ClimateMode.Heat).threshold).toBe(17);
  });

  it('shows a custom fan mode as 0% (Auto)', () => {
    expect(homeKitValues(climateState({ fanMode: 0, customFanMode: 'silent' }), traits, ClimateMode.Heat).rotationSpeed)
      .toBe(0);
  });

  it('shows any swing mode as swing enabled', () => {
    expect(homeKitValues(climateState({ swingMode: ClimateSwingMode.Horizontal }), traits, ClimateMode.Heat).swing)
      .toBe(SwingMode.SWING_ENABLED);
    expect(homeKitValues(climateState({ swingMode: ClimateSwingMode.Off }), traits, ClimateMode.Heat).swing)
      .toBe(SwingMode.SWING_DISABLED);
  });
});

describe('resolveCommand', () => {
  const off = climateState({ mode: ClimateMode.Off });

  describe('turning on', () => {
    it('Heat at 75°F from off, as one batch', () => {
      expect(resolve({
        active: Active.ACTIVE,
        targetState: TargetHeaterCoolerState.HEAT,
        heatingThreshold: fahrenheitToCelsius(75),
      }, { state: off, lastHeatCoolMode: ClimateMode.Cool, lastOnMode: ClimateMode.Cool }))
        .toEqual({ mode: ClimateMode.Heat, targetTemperature: 24 });
    });

    it('Active alone resumes the last mode the AC was on in', () => {
      expect(resolve({ active: Active.ACTIVE }, { state: off, lastOnMode: ClimateMode.Dry }))
        .toEqual({ mode: ClimateMode.Dry });
    });

    it('Active while already on changes nothing', () => {
      expect(resolve({ active: Active.ACTIVE })).toEqual({});
    });
  });

  describe('turning off', () => {
    it('Active=0 turns off, even alongside a mode choice', () => {
      expect(resolve({ active: Active.INACTIVE, targetState: TargetHeaterCoolerState.COOL }))
        .toEqual({ mode: ClimateMode.Off });
    });
  });

  describe('thresholds', () => {
    it('in Cool, a scene writing both thresholds sets the cooling one', () => {
      expect(resolve({ coolingThreshold: 22, heatingThreshold: 17 }, { state: climateState({ mode: ClimateMode.Cool }) }))
        .toEqual({ targetTemperature: 22 });
    });

    it('in Heat, a scene writing both thresholds sets the heating one', () => {
      expect(resolve({ coolingThreshold: 30, heatingThreshold: 23 }))
        .toEqual({ targetTemperature: 23 });
    });

    it('uses the threshold for the mode being switched to', () => {
      expect(resolve({ targetState: TargetHeaterCoolerState.COOL, coolingThreshold: 22, heatingThreshold: 17 }))
        .toEqual({ mode: ClimateMode.Cool, targetTemperature: 22 });
    });

    it('applies a lone threshold whichever it is (there is one setpoint)', () => {
      expect(resolve({ coolingThreshold: 23 })).toEqual({ targetTemperature: 23 });
    });

    it('sets the temperature while off without turning on', () => {
      expect(resolve({ heatingThreshold: 22 }, { state: off })).toEqual({ targetTemperature: 22 });
    });

    it('leaves out a temperature that already matches', () => {
      expect(resolve({ heatingThreshold: 21.1 })).toEqual({});
    });
  });

  describe('mode switches', () => {
    it('Dry on switches to Dry', () => {
      expect(resolve({ modeSwitches: new Map([[ClimateMode.Dry, true]]) })).toEqual({ mode: ClimateMode.Dry });
    });

    it('Dry off returns to the last heat/cool mode', () => {
      expect(resolve({ modeSwitches: new Map([[ClimateMode.Dry, false]]) },
        { state: climateState({ mode: ClimateMode.Dry }), lastHeatCoolMode: ClimateMode.Cool }))
        .toEqual({ mode: ClimateMode.Cool });
    });

    it('Dry off while not in Dry changes nothing', () => {
      expect(resolve({ modeSwitches: new Map([[ClimateMode.Dry, false]]) })).toEqual({});
    });

    it('a scene recorded in Dry (target state COOL + Dry on) restores Dry', () => {
      expect(resolve({
        active: Active.ACTIVE,
        targetState: TargetHeaterCoolerState.COOL,
        modeSwitches: new Map([[ClimateMode.Dry, true], [ClimateMode.FanOnly, false]]),
      })).toEqual({ mode: ClimateMode.Dry });
    });

    it('selecting Cool in the tile while in Dry switches to Cool', () => {
      expect(resolve({ targetState: TargetHeaterCoolerState.COOL }, { state: climateState({ mode: ClimateMode.Dry }) }))
        .toEqual({ mode: ClimateMode.Cool });
    });
  });

  describe('fan, swing, presets', () => {
    it('sets a fan mode from the rotation speed', () => {
      expect(resolve({ rotationSpeed: 100 })).toEqual({ fanMode: ClimateFanMode.High });
      expect(resolve({ rotationSpeed: 0 }, { state: climateState({ fanMode: ClimateFanMode.Low }) }))
        .toEqual({ fanMode: ClimateFanMode.Auto });
    });

    it('enables swing with the configured mode and disables it with Off', () => {
      expect(resolve({ swing: SwingMode.SWING_ENABLED }, {
        state: climateState({ swingMode: ClimateSwingMode.Off }),
        swingMode: ClimateSwingMode.Horizontal,
      })).toEqual({ swingMode: ClimateSwingMode.Horizontal });
      expect(resolve({ swing: SwingMode.SWING_DISABLED })).toEqual({ swingMode: ClimateSwingMode.Off });
    });

    it('leaves an existing swing mode alone when swing is enabled again', () => {
      expect(resolve({ swing: SwingMode.SWING_ENABLED })).toEqual({});
    });

    it('turns presets on, and off to None', () => {
      expect(resolve({ presetSwitches: new Map([[ClimatePreset.Boost, true]]) })).toEqual({ preset: ClimatePreset.Boost });
      expect(resolve({ presetSwitches: new Map([[ClimatePreset.Boost, false]]) },
        { state: climateState({ preset: ClimatePreset.Boost }) })).toEqual({ preset: ClimatePreset.None });
    });

    it('switching from one preset to another keeps the new one', () => {
      expect(resolve({ presetSwitches: new Map([[ClimatePreset.Sleep, false], [ClimatePreset.Boost, true]]) },
        { state: climateState({ preset: ClimatePreset.Sleep }) })).toEqual({ preset: ClimatePreset.Boost });
    });
  });
});
