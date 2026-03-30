// Runtime constants for ESPHome protobuf enums.
// The @2colors/esphome-native-api package declares these as TypeScript enums
// in its .d.ts but does not export them as runtime values.

export const ClimateMode = {
  Off: 0,
  HeatCool: 1,
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
