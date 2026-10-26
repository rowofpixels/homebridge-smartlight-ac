// Runtime constants and types for the ESPHome native API messages this plugin uses.
// The @2colors/esphome-native-api package declares its enums only as TypeScript
// types, and its .d.ts lags the protobuf it ships (e.g. it still lists
// `visualTemperatureStep` and `uniqueId`), so we describe the decoded messages here.

export const ClimateMode = {
  Off: 0,
  HeatCool: 1, // Midea reports its own "Auto" mode as HEAT_COOL
  Cool: 2,
  Heat: 3,
  FanOnly: 4,
  Dry: 5,
  Auto: 6,
} as const;

export const ClimateFanMode = {
  On: 0,
  Off: 1,
  Auto: 2,
  Low: 3,
  Medium: 4,
  High: 5,
  Middle: 6,
  Focus: 7,
  Diffuse: 8,
  Quiet: 9,
} as const;

export const ClimateSwingMode = {
  Off: 0,
  Both: 1,
  Vertical: 2,
  Horizontal: 3,
} as const;

export const ClimateAction = {
  Off: 0,
  Cooling: 2,
  Heating: 3,
  Idle: 4,
  Drying: 5,
  Fan: 6,
} as const;

export const ClimatePreset = {
  None: 0,
  Home: 1,
  Away: 2,
  Boost: 3,
  Comfort: 4,
  Eco: 5,
  Sleep: 6,
  Activity: 7,
} as const;

export const LogLevel = {
  None: 0,
  Error: 1,
  Warn: 2,
  Info: 3,
  Config: 4,
  Debug: 5,
  Verbose: 6,
  VeryVerbose: 7,
} as const;

/** Look up the name of an enum value, e.g. enumName(ClimateMode, 3) === 'Heat'. */
export function enumName(enumObject: Record<string, number>, value: number): string {
  const entry = Object.entries(enumObject).find(([, v]) => v === value);
  return entry ? entry[0] : String(value);
}

/** Common fields of every ListEntities*Response. */
export interface EntityConfig {
  objectId: string;
  key: number;
  name: string;
  deviceClass?: string;
  unitOfMeasurement?: string;
}

/** ListEntitiesClimateResponse, as decoded by the library. */
export interface ClimateConfig extends EntityConfig {
  supportsCurrentTemperature: boolean;
  supportsTwoPointTargetTemperature: boolean;
  supportsAction: boolean;
  supportedModesList: number[];
  visualMinTemperature: number;
  visualMaxTemperature: number;
  visualTargetTemperatureStep: number;
  supportedFanModesList: number[];
  supportedCustomFanModesList: string[];
  supportedSwingModesList: number[];
  supportedPresetsList: number[];
  supportedCustomPresetsList: string[];
}

/** ClimateStateResponse, as decoded by the library. */
export interface ClimateState {
  key: number;
  mode: number;
  action: number;
  currentTemperature: number;
  targetTemperature: number;
  fanMode: number;
  customFanMode: string;
  swingMode: number;
  preset: number;
  customPreset: string;
}

/** Fields of a ClimateCommandRequest; only the fields present are changed. */
export interface ClimateCommand {
  mode?: number;
  targetTemperature?: number;
  fanMode?: number;
  customFanMode?: string;
  swingMode?: number;
  preset?: number;
  customPreset?: string;
}

export interface DeviceInfo {
  name: string;
  friendlyName: string;
  macAddress: string;
  esphomeVersion: string;
  model: string;
  manufacturer: string;
  projectName: string;
  projectVersion: string;
}
