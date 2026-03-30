export const PLATFORM_NAME = 'SmartlightAC';
export const PLUGIN_NAME = 'homebridge-smartlight-ac';

export interface SmartlightDeviceConfig {
  name: string;
  host: string;
  port: number;
  password?: string;
  encryptionKey?: string;
}

export interface SmartlightPlatformConfig {
  name: string;
  devices: SmartlightDeviceConfig[];
}
