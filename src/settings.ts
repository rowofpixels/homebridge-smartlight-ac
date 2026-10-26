export const PLATFORM_NAME = 'SmartlightAC';
export const PLUGIN_NAME = 'homebridge-smartlight-ac';

export type SwingSetting = 'vertical' | 'horizontal' | 'both';

export interface SmartlightDeviceConfig {
  name: string;
  host: string;
  port?: number;
  password?: string;
  encryptionKey?: string;
  /** Which louvers move when swing is turned on in HomeKit. Default: vertical. */
  swing?: SwingSetting;
  /** Show a switch for Dry mode. Default: true. */
  dryModeSwitch?: boolean;
  /** Show a switch for Fan-only mode. Default: true. */
  fanOnlySwitch?: boolean;
  /** Show switches for the Boost and Sleep presets. Default: false. */
  presetSwitches?: boolean;
  /** Show the outdoor temperature as a sensor. Default: true. */
  outdoorTemperature?: boolean;
}

export interface SmartlightPlatformConfig {
  name: string;
  debug?: boolean;
  devices: SmartlightDeviceConfig[];
}
