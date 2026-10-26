import {
  ClimateFanMode,
  ClimateMode,
  ClimatePreset,
  ClimateSwingMode,
  enumName,
  type ClimateCommand,
  type ClimateState,
} from './esphome.js';

const TEMPERATURE_TOLERANCE = 0.01;

export function roundToStep(value: number, step: number): number {
  if (!(step > 0)) {
    return value;
  }
  return Math.round(value / step) * step;
}

/** The fan setting as one name: a custom fan mode (e.g. "silent") or a standard one. */
export function fanSetting(state: Pick<ClimateState, 'fanMode' | 'customFanMode'>): string {
  return state.customFanMode || enumName(ClimateFanMode, state.fanMode);
}

/** The preset as one name: a custom preset (e.g. "freeze protection") or a standard one. */
export function presetSetting(state: Pick<ClimateState, 'preset' | 'customPreset'>): string {
  return state.customPreset || enumName(ClimatePreset, state.preset);
}

export function describeState(state: ClimateState): string {
  return `mode=${enumName(ClimateMode, state.mode)} target=${state.targetTemperature}°C ` +
    `current=${state.currentTemperature}°C fan=${fanSetting(state)} ` +
    `swing=${enumName(ClimateSwingMode, state.swingMode)} preset=${presetSetting(state)}`;
}

export function describeCommand(command: ClimateCommand): string {
  const parts: string[] = [];
  if (command.mode !== undefined) {
    parts.push(`mode=${enumName(ClimateMode, command.mode)}`);
  }
  if (command.targetTemperature !== undefined) {
    parts.push(`target=${command.targetTemperature}°C`);
  }
  if (command.fanMode !== undefined) {
    parts.push(`fan=${enumName(ClimateFanMode, command.fanMode)}`);
  }
  if (command.customFanMode !== undefined) {
    parts.push(`fan=${command.customFanMode}`);
  }
  if (command.swingMode !== undefined) {
    parts.push(`swing=${enumName(ClimateSwingMode, command.swingMode)}`);
  }
  if (command.preset !== undefined) {
    parts.push(`preset=${enumName(ClimatePreset, command.preset)}`);
  }
  if (command.customPreset !== undefined) {
    parts.push(`preset=${command.customPreset}`);
  }
  return parts.join(' ');
}

/** `state` as it will be once `command` is applied. */
export function applyCommand(state: ClimateState, command: ClimateCommand): ClimateState {
  const result = { ...state };
  if (command.mode !== undefined) {
    result.mode = command.mode;
  }
  if (command.targetTemperature !== undefined) {
    result.targetTemperature = command.targetTemperature;
  }
  // A custom fan mode or preset replaces the standard one, and vice versa.
  if (command.fanMode !== undefined) {
    result.fanMode = command.fanMode;
    result.customFanMode = '';
  }
  if (command.customFanMode !== undefined) {
    result.customFanMode = command.customFanMode;
  }
  if (command.swingMode !== undefined) {
    result.swingMode = command.swingMode;
  }
  if (command.preset !== undefined) {
    result.preset = command.preset;
    result.customPreset = '';
  }
  if (command.customPreset !== undefined) {
    result.customPreset = command.customPreset;
  }
  return result;
}

/** The fields of `command` that `state` does not reflect yet. */
export function unconfirmedFields(command: ClimateCommand, state: ClimateState): Array<keyof ClimateCommand> {
  const fields: Array<keyof ClimateCommand> = [];
  if (command.mode !== undefined && state.mode !== command.mode) {
    fields.push('mode');
  }
  if (command.targetTemperature !== undefined &&
    Math.abs(state.targetTemperature - command.targetTemperature) > TEMPERATURE_TOLERANCE) {
    fields.push('targetTemperature');
  }
  // A custom fan mode or preset replaces the standard one in the reported state.
  if (command.fanMode !== undefined && (state.fanMode !== command.fanMode || state.customFanMode)) {
    fields.push('fanMode');
  }
  if (command.customFanMode !== undefined && state.customFanMode !== command.customFanMode) {
    fields.push('customFanMode');
  }
  if (command.swingMode !== undefined && state.swingMode !== command.swingMode) {
    fields.push('swingMode');
  }
  if (command.preset !== undefined && (state.preset !== command.preset || state.customPreset)) {
    fields.push('preset');
  }
  if (command.customPreset !== undefined && state.customPreset !== command.customPreset) {
    fields.push('customPreset');
  }
  return fields;
}
