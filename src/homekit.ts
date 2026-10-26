// Pure mapping between ESPHome climate state and HomeKit HeaterCooler values.
//
// Device facts this relies on (verified on an SLWF-01pro, firmware 2.1, ESPHome 2024.4.2):
// - The reported mode is accurate, and temperature-only commands leave the mode alone.
// - There is one setpoint shared by every mode; it can be changed while the AC is off.
// - The firmware rounds setpoints to 0.5 °C. An AC that displays °F keeps whole °F,
//   so it may settle 0.5 °C away from what was sent (22.5 °C → 72.5 °F → 73 °F → 23 °C).
// - `action` is never reported, so heating/cooling has to be inferred.
// - Midea's own "Auto" is ESPHome's HEAT_COOL, with a single setpoint. HomeKit's Auto
//   is a heat/cool range, so we don't offer it.

import { roundToStep } from './climate.js';
import {
  ClimateAction,
  ClimateFanMode,
  ClimateMode,
  ClimatePreset,
  ClimateSwingMode,
  type ClimateCommand,
  type ClimateConfig,
  type ClimateState,
} from './esphome.js';

// HomeKit characteristic values, as defined by the HAP specification.
export const Active = { INACTIVE: 0, ACTIVE: 1 } as const;
export const CurrentHeaterCoolerState = { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 } as const;
export const TargetHeaterCoolerState = { AUTO: 0, HEAT: 1, COOL: 2 } as const;
export const SwingMode = { SWING_DISABLED: 0, SWING_ENABLED: 1 } as const;

/** Modes offered as extra switches, because HeaterCooler has no place for them. */
export const SWITCH_MODES = [ClimateMode.Dry, ClimateMode.FanOnly] as const;

/** Presets offered as extra switches. Eco is left out: it only works in Cool and forces 24 °C. */
export const SWITCH_PRESETS = [ClimatePreset.Boost, ClimatePreset.Sleep] as const;

const MANUAL_FAN_MODES = [ClimateFanMode.Low, ClimateFanMode.Medium, ClimateFanMode.High];

export type HeatCoolMode = typeof ClimateMode.Heat | typeof ClimateMode.Cool;

export function isHeatCoolMode(mode: number): mode is HeatCoolMode {
  return mode === ClimateMode.Heat || mode === ClimateMode.Cool;
}

/** TargetHeaterCoolerState values the device supports. */
export function targetStates(traits: ClimateConfig): number[] {
  const states: number[] = [];
  if (traits.supportedModesList.includes(ClimateMode.Heat)) {
    states.push(TargetHeaterCoolerState.HEAT);
  }
  if (traits.supportedModesList.includes(ClimateMode.Cool)) {
    states.push(TargetHeaterCoolerState.COOL);
  }
  return states.length > 0 ? states : [TargetHeaterCoolerState.COOL];
}

export function targetStateToMode(targetState: number): HeatCoolMode {
  return targetState === TargetHeaterCoolerState.HEAT ? ClimateMode.Heat : ClimateMode.Cool;
}

export function modeToTargetState(mode: HeatCoolMode): number {
  return mode === ClimateMode.Heat ? TargetHeaterCoolerState.HEAT : TargetHeaterCoolerState.COOL;
}

/** Manual fan modes the device supports, slowest first. RotationSpeed 0% stands for Auto. */
export function manualFanModes(traits: ClimateConfig): number[] {
  return MANUAL_FAN_MODES.filter((mode) => traits.supportedFanModesList.includes(mode));
}

/** Low/Medium/High become evenly spaced stops (33/67/100%); Auto and anything else is 0%. */
export function fanModeToSpeed(fanMode: number, manualModes: number[]): number {
  const index = manualModes.indexOf(fanMode);
  return index < 0 ? 0 : (100 * (index + 1)) / manualModes.length;
}

export function speedToFanMode(speed: number, manualModes: number[]): number {
  if (speed <= 0 || manualModes.length === 0) {
    return ClimateFanMode.Auto;
  }
  // Nearest stop; any non-zero speed is at least the slowest manual mode.
  const index = Math.round((speed * manualModes.length) / 100) - 1;
  return manualModes[Math.min(manualModes.length - 1, Math.max(0, index))];
}

/** Heating/cooling/idle, inferred from the temperatures when the device doesn't report it. */
export function currentHeaterCoolerState(state: ClimateState, traits: ClimateConfig): number {
  if (state.mode === ClimateMode.Off) {
    return CurrentHeaterCoolerState.INACTIVE;
  }
  if (traits.supportsAction) {
    switch (state.action) {
      case ClimateAction.Heating:
        return CurrentHeaterCoolerState.HEATING;
      case ClimateAction.Cooling:
      case ClimateAction.Drying:
        return CurrentHeaterCoolerState.COOLING;
      case ClimateAction.Off:
        return CurrentHeaterCoolerState.INACTIVE;
      default:
        return CurrentHeaterCoolerState.IDLE;
    }
  }
  const { currentTemperature: current, targetTemperature: target } = state;
  const heating = current < target;
  const cooling = current > target;
  switch (state.mode) {
    case ClimateMode.Heat:
      return heating ? CurrentHeaterCoolerState.HEATING : CurrentHeaterCoolerState.IDLE;
    case ClimateMode.Cool:
    case ClimateMode.Dry:
      return cooling ? CurrentHeaterCoolerState.COOLING : CurrentHeaterCoolerState.IDLE;
    case ClimateMode.HeatCool:
      return heating ? CurrentHeaterCoolerState.HEATING
        : cooling ? CurrentHeaterCoolerState.COOLING
          : CurrentHeaterCoolerState.IDLE;
    default:
      return CurrentHeaterCoolerState.IDLE;
  }
}

export function clampTemperature(value: number, traits: ClimateConfig): number {
  return Math.min(traits.visualMaxTemperature, Math.max(traits.visualMinTemperature, value));
}

/** HomeKit sends Celsius (converted from °F on the phone); the device takes 0.5 °C steps. */
export function toDeviceTemperature(value: number, traits: ClimateConfig): number {
  return clampTemperature(roundToStep(value, traits.visualTargetTemperatureStep || 0.5), traits);
}

/** Everything HomeKit shows, derived from one climate state. */
export interface HomeKitValues {
  active: number;
  currentState: number;
  /** HEAT or COOL. In modes HomeKit can't show (Dry, Fan only, Midea Auto) this is the last heat/cool mode. */
  targetState: number;
  currentTemperature: number;
  /** Both thresholds show the device's single setpoint. */
  threshold: number;
  rotationSpeed: number;
  swing: number;
  modeSwitches: Map<number, boolean>;
  presetSwitches: Map<number, boolean>;
}

export function homeKitValues(state: ClimateState, traits: ClimateConfig, lastHeatCoolMode: HeatCoolMode): HomeKitValues {
  return {
    active: state.mode === ClimateMode.Off ? Active.INACTIVE : Active.ACTIVE,
    currentState: currentHeaterCoolerState(state, traits),
    targetState: modeToTargetState(isHeatCoolMode(state.mode) ? state.mode : lastHeatCoolMode),
    currentTemperature: state.currentTemperature,
    threshold: clampTemperature(state.targetTemperature, traits),
    rotationSpeed: state.customFanMode ? 0 : fanModeToSpeed(state.fanMode, manualFanModes(traits)),
    swing: state.swingMode === ClimateSwingMode.Off ? SwingMode.SWING_DISABLED : SwingMode.SWING_ENABLED,
    modeSwitches: new Map(SWITCH_MODES.map((mode) => [mode, state.mode === mode])),
    presetSwitches: new Map(SWITCH_PRESETS.map((preset) => [preset, !state.customPreset && state.preset === preset])),
  };
}

/** HomeKit writes collected over one debounce window. */
export interface Intents {
  active?: number;
  targetState?: number;
  coolingThreshold?: number;
  heatingThreshold?: number;
  rotationSpeed?: number;
  swing?: number;
  /** Dry / Fan-only switches: mode → on. */
  modeSwitches?: Map<number, boolean>;
  /** Preset switches: preset → on. */
  presetSwitches?: Map<number, boolean>;
}

export interface ResolveContext {
  /** The state to apply the intents to: the device's, plus any unconfirmed commands. */
  state: ClimateState;
  traits: ClimateConfig;
  lastHeatCoolMode: HeatCoolMode;
  /** The mode to resume when HomeKit only says "turn on". */
  lastOnMode: number;
  /** The swing mode to use when HomeKit enables swing. */
  swingMode: number;
}

/**
 * Turn one batch of HomeKit writes into a single command.
 *
 * HomeKit sends related writes together (e.g. Active + TargetHeaterCoolerState +
 * a threshold when a scene runs) in no particular order, so they are resolved as
 * a whole rather than one at a time. Fields that already match `state` are left out.
 */
export function resolveCommand(intents: Intents, context: ResolveContext): ClimateCommand {
  const { state, traits } = context;
  const command: ClimateCommand = {};

  const mode = resolveMode(intents, context);
  if (mode !== undefined && mode !== state.mode) {
    command.mode = mode;
  }

  // One setpoint serves both thresholds. If both were written, use the one for the mode in effect.
  const { heatingThreshold, coolingThreshold } = intents;
  let target: number | undefined;
  if (heatingThreshold !== undefined && coolingThreshold !== undefined) {
    const effective = [mode, state.mode].find((m) => m !== undefined && isHeatCoolMode(m)) ?? context.lastHeatCoolMode;
    target = effective === ClimateMode.Heat ? heatingThreshold : coolingThreshold;
  } else {
    target = heatingThreshold ?? coolingThreshold;
  }
  if (target !== undefined) {
    const deviceTarget = toDeviceTemperature(target, traits);
    if (Math.abs(deviceTarget - state.targetTemperature) > 0.01) {
      command.targetTemperature = deviceTarget;
    }
  }

  if (intents.rotationSpeed !== undefined) {
    const fanMode = speedToFanMode(intents.rotationSpeed, manualFanModes(traits));
    if (fanMode !== state.fanMode || state.customFanMode) {
      command.fanMode = fanMode;
    }
  }

  if (intents.swing !== undefined) {
    const enable = intents.swing === SwingMode.SWING_ENABLED;
    if (enable && state.swingMode === ClimateSwingMode.Off) {
      command.swingMode = context.swingMode;
    } else if (!enable && state.swingMode !== ClimateSwingMode.Off) {
      command.swingMode = ClimateSwingMode.Off;
    }
  }

  for (const [preset, on] of intents.presetSwitches ?? []) {
    const active = !state.customPreset && state.preset === preset;
    if (on && !active) {
      command.preset = preset;
    } else if (!on && active && command.preset === undefined) {
      command.preset = ClimatePreset.None;
    }
  }

  return command;
}

function resolveMode(intents: Intents, context: ResolveContext): number | undefined {
  const { state } = context;
  if (intents.active === Active.INACTIVE) {
    return ClimateMode.Off;
  }
  const switches = [...(intents.modeSwitches ?? [])];
  // A Dry/Fan-only switch turned on is more specific than TargetHeaterCoolerState,
  // which always holds Heat or Cool (e.g. a scene recorded in Dry writes both).
  const switchedOn = switches.find(([, on]) => on);
  if (switchedOn) {
    return switchedOn[0];
  }
  if (intents.targetState !== undefined) {
    return targetStateToMode(intents.targetState);
  }
  if (switches.some(([mode, on]) => !on && mode === state.mode)) {
    return context.lastHeatCoolMode;
  }
  if (intents.active === Active.ACTIVE && state.mode === ClimateMode.Off) {
    return context.lastOnMode;
  }
  return undefined;
}
