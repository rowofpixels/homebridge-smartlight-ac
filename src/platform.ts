import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { AcDevice } from './device.js';
import { PLATFORM_NAME, PLUGIN_NAME, type SmartlightDeviceConfig } from './settings.js';
import { SmartlightAccessory } from './platformAccessory.js';

export class SmartlightPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly debugMode: boolean;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly duplicateAccessories: PlatformAccessory[] = [];
  private readonly devices: AcDevice[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.debugMode = config.debug === true;

    this.api.on('didFinishLaunching', () => this.setUpDevices());
    this.api.on('shutdown', () => {
      for (const device of this.devices) {
        device.disconnect();
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    if (this.cachedAccessories.has(accessory.UUID)) {
      // Versions ≤ 0.1.14 on Homebridge 2 betas could save an accessory twice (see
      // `register`). Both copies get published, so HomeKit saw a stale twin of the AC.
      this.duplicateAccessories.push(accessory);
      return;
    }
    this.log.debug('Restoring cached accessory:', accessory.displayName);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private setUpDevices(): void {
    if (this.duplicateAccessories.length > 0) {
      this.log.info(`Removing ${this.duplicateAccessories.length} duplicate cached accessory(ies)`);
      this.unregister(this.duplicateAccessories);
    }

    const devices = (this.config.devices ?? []) as SmartlightDeviceConfig[];
    if (devices.length === 0) {
      this.log.warn('No devices configured');
    }

    const configured = new Set<string>();
    for (const deviceConfig of devices) {
      if (!deviceConfig.host) {
        this.log.error(`Device "${deviceConfig.name ?? '(unnamed)'}" has no host; skipping`);
        continue;
      }
      // Same UUID scheme as earlier versions, so HomeKit keeps the existing accessory.
      const uuid = this.api.hap.uuid.generate(`${deviceConfig.host}-climate`);
      if (configured.has(uuid)) {
        this.log.warn(`Device ${deviceConfig.host} is configured more than once; skipping the duplicate`);
        continue;
      }
      configured.add(uuid);
      this.setUpDevice(deviceConfig, uuid);
    }

    const stale = [...this.cachedAccessories.values()].filter((a) => !configured.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing accessories no longer in the config: ${stale.map((a) => a.displayName).join(', ')}`);
      this.unregister(stale);
    }
  }

  // Homebridge 2 betas handle (un)registration twice: once in Server and once in
  // BridgeService. The second pass throws (the accessory is already (un)bridged),
  // and a second register also adds a duplicate to the accessory cache, which
  // updatePlatformAccessories() removes again.
  private register(accessory: PlatformAccessory): void {
    try {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } catch (error) {
      this.log.debug('registerPlatformAccessories threw (Homebridge 2 beta double handling):', (error as Error).message);
    }
    this.api.updatePlatformAccessories([accessory]);
  }

  private unregister(accessories: PlatformAccessory[]): void {
    try {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
    } catch (error) {
      this.log.debug('unregisterPlatformAccessories threw (Homebridge 2 beta double handling):', (error as Error).message);
    }
  }

  private setUpDevice(deviceConfig: SmartlightDeviceConfig, uuid: string): void {
    const name = deviceConfig.name || deviceConfig.host;
    let accessory = this.cachedAccessories.get(uuid);
    const isNew = !accessory;
    accessory ??= new this.api.platformAccessory(name, uuid);
    accessory.context.deviceConfig = deviceConfig;

    const device = new AcDevice({
      name,
      host: deviceConfig.host,
      port: deviceConfig.port,
      password: deviceConfig.password,
      encryptionKey: deviceConfig.encryptionKey,
      clientInfo: `${PLUGIN_NAME} ${name}`,
      log: this.log,
    });
    this.devices.push(device);

    new SmartlightAccessory(this, accessory, device, deviceConfig);

    if (isNew) {
      this.log.info('Adding new accessory:', name);
      this.register(accessory);
    }

    try {
      device.connect();
    } catch (error) {
      this.log.error(`[${name}] Could not connect: ${(error as Error).message}`);
    }
  }
}
