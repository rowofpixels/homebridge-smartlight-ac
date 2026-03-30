import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import pkg from '@2colors/esphome-native-api';
const { Client } = pkg;
import type { Entity, ClimateEntity } from '@2colors/esphome-native-api';
import { PLATFORM_NAME, PLUGIN_NAME, type SmartlightDeviceConfig } from './settings.js';
import { SmartlightAccessory } from './platformAccessory.js';

export class SmartlightPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly registeredUUIDs = new Set<string>();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const devices = (config.devices ?? []) as SmartlightDeviceConfig[];
    if (devices.length === 0) {
      this.log.warn('No devices configured');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      for (const device of devices) {
        this.connectDevice(device);
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring cached accessory:', accessory.displayName);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private connectDevice(deviceConfig: SmartlightDeviceConfig): void {
    const port = deviceConfig.port ?? 6053;
    this.log.info(`Connecting to ${deviceConfig.name} at ${deviceConfig.host}:${port}`);

    const client = new Client({
      host: deviceConfig.host,
      port,
      password: deviceConfig.password,
      encryptionKey: deviceConfig.encryptionKey,
      reconnect: true,
      reconnectInterval: 15000,
      clientInfo: `${PLUGIN_NAME} ${deviceConfig.name}`,
    });

    client.on('newEntity', (entity: Entity) => {
      this.log.debug(`[${deviceConfig.name}] Discovered entity: type=${entity.type} name=${entity.name} key=${entity.id}`);
      if (entity.type === 'Climate') {
        this.registerClimateAccessory(deviceConfig, entity as ClimateEntity);
      }
    });

    client.on('error', (error: Error) => {
      this.log.error(`[${deviceConfig.name}] Connection error:`, error.message);
    });

    client.on('disconnected', () => {
      this.log.warn(`[${deviceConfig.name}] Disconnected, will reconnect...`);
    });

    client.on('connected', () => {
      this.log.info(`[${deviceConfig.name}] Connected`);
    });

    client.connect();
  }

  private registerClimateAccessory(deviceConfig: SmartlightDeviceConfig, entity: ClimateEntity): void {
    const uuid = this.api.hap.uuid.generate(
      entity.config.uniqueId || `${deviceConfig.host}-climate`,
    );

    // Prevent double-registration on reconnect (Client re-emits newEntity)
    if (this.registeredUUIDs.has(uuid)) {
      this.log.debug('Skipping already-registered accessory:', deviceConfig.name);
      return;
    }
    this.registeredUUIDs.add(uuid);

    const existingAccessory = this.cachedAccessories.get(uuid);
    if (existingAccessory) {
      this.log.info('Restoring climate accessory from cache:', deviceConfig.name);
      existingAccessory.context.deviceConfig = deviceConfig;
      new SmartlightAccessory(this, existingAccessory, entity);
      return;
    }

    this.log.info('Adding new climate accessory:', deviceConfig.name);
    const accessory = new this.api.platformAccessory(deviceConfig.name, uuid);
    accessory.context.deviceConfig = deviceConfig;

    new SmartlightAccessory(this, accessory, entity);

    try {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } catch (e) {
      // Workaround for homebridge v2 beta double-registration bug:
      // both Server and BridgeService listen for 'registerPlatformAccessories',
      // causing addBridgedAccessory to be called twice for the same accessory.
      this.log.debug('registerPlatformAccessories threw (likely beta double-listener bug):', (e as Error).message);
    }
  }
}
