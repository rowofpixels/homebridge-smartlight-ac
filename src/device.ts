import { EventEmitter } from 'node:events';
import pkg from '@2colors/esphome-native-api';
import type { ClimateCommand, ClimateConfig, ClimateState, DeviceInfo, EntityConfig } from './esphome.js';

const { Client } = pkg;

export interface DeviceLog {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface AcDeviceOptions {
  /** Name used to prefix log messages. */
  name: string;
  host: string;
  port?: number;
  password?: string;
  encryptionKey?: string;
  clientInfo: string;
  reconnectInterval?: number;
  /** Stream the device's own log output at this ESPHome log level, as 'deviceLog' events. */
  deviceLogLevel?: number;
  log: DeviceLog;
}

/** The parts of an @2colors/esphome-native-api entity this module uses. */
export interface EsphomeEntity extends EventEmitter {
  type: string;
  config: EntityConfig;
  command(data: object): void;
}

/** The parts of an @2colors/esphome-native-api Client this module uses. */
export interface EsphomeClient extends EventEmitter {
  connect(): void;
  disconnect(): void;
}

export type ClientFactory = (options: Record<string, unknown>) => EsphomeClient;

const defaultClientFactory: ClientFactory = (options) =>
  new Client(options as unknown as ConstructorParameters<typeof Client>[0]) as unknown as EsphomeClient;

export type EntityValue = number | boolean | string;

/**
 * A connection to one ESPHome AC controller.
 *
 * The underlying client replaces every entity object on each reconnect, so
 * consumers must not hold on to entities; this class rebinds to the new ones
 * and keeps the latest state.
 *
 * Events:
 * - 'availability' (available: boolean): connected and receiving climate state, or not
 * - 'climateConfig' (config: ClimateConfig): the climate entity's traits, on every (re)connect
 * - 'climateState' (state: ClimateState)
 * - 'entityState' (objectId: string, value: EntityValue): sensors, switches, etc.
 * - 'deviceInfo' (info: DeviceInfo)
 * - 'deviceLog' (line: string): only when `deviceLogLevel` is set
 */
export class AcDevice extends EventEmitter {
  deviceInfo: DeviceInfo | null = null;
  climateConfig: ClimateConfig | null = null;
  climateState: ClimateState | null = null;
  /** Non-climate entities by objectId. */
  readonly entities = new Map<string, { type: string; config: EntityConfig }>();
  readonly entityStates = new Map<string, EntityValue>();

  private readonly client: EsphomeClient;
  private readonly boundEntities = new Map<string, EsphomeEntity>();
  private climate: EsphomeEntity | null = null;
  private _available = false;
  private closing = false;

  constructor(private readonly options: AcDeviceOptions, createClient: ClientFactory = defaultClientFactory) {
    super();
    const { log } = options;

    this.client = createClient({
      host: options.host,
      port: options.port ?? 6053,
      password: options.password,
      encryptionKey: options.encryptionKey,
      reconnect: true,
      reconnectInterval: options.reconnectInterval ?? 15000,
      clientInfo: options.clientInfo,
      initializeSubscribeLogs: options.deviceLogLevel === undefined
        ? false
        : { level: options.deviceLogLevel, dumpConfig: true },
    });

    this.client.on('connected', () => log.info(this.prefix('Connected')));
    this.client.on('disconnected', () => {
      if (!this.closing) {
        log.warn(this.prefix('Disconnected, will reconnect...'));
      }
      this.setAvailable(false);
    });
    this.client.on('initialized', () => {
      if (!this.climate) {
        log.warn(this.prefix('Connected, but the device has no climate entity'));
      }
    });
    this.client.on('error', (error: unknown) => {
      log.warn(this.prefix(`Connection error: ${error instanceof Error ? error.message : String(error)}`));
    });
    this.client.on('deviceInfo', (info: DeviceInfo) => {
      this.deviceInfo = info;
      this.emit('deviceInfo', info);
    });
    this.client.on('newEntity', (entity: EsphomeEntity) => this.bindEntity(entity));
    this.client.on('logs', (data: { message: string }) => {
      // eslint-disable-next-line no-control-regex
      this.emit('deviceLog', String(data.message).replace(/\x1b\[[0-9;]*m/g, ''));
    });
  }

  get available(): boolean {
    return this._available;
  }

  connect(): void {
    this.options.log.info(this.prefix(`Connecting to ${this.options.host}:${this.options.port ?? 6053}`));
    this.client.connect();
  }

  disconnect(): void {
    this.closing = true;
    this.client.disconnect();
    this.setAvailable(false);
  }

  /** Send a climate command. Returns false (and logs why) if it could not be sent. Never throws. */
  sendClimateCommand(command: ClimateCommand): boolean {
    if (!this.climate || !this._available) {
      this.options.log.warn(this.prefix('Not connected; command not sent'));
      return false;
    }
    return this.send(this.climate, command);
  }

  /** Turn a switch entity on or off. Returns false (and logs why) if it could not be sent. */
  sendSwitchCommand(objectId: string, state: boolean): boolean {
    const entity = this.boundEntities.get(objectId);
    if (!entity || entity.type !== 'Switch' || !this._available) {
      this.options.log.warn(this.prefix(`Switch ${objectId} unavailable; command not sent`));
      return false;
    }
    return this.send(entity, { state });
  }

  private send(entity: EsphomeEntity, data: object): boolean {
    try {
      entity.command(data);
      return true;
    } catch (error) {
      this.options.log.warn(this.prefix(`Failed to send command: ${(error as Error).message}`));
      return false;
    }
  }

  private bindEntity(entity: EsphomeEntity): void {
    const { objectId } = entity.config;
    this.boundEntities.set(objectId, entity);
    entity.once('destroyed', () => {
      if (this.boundEntities.get(objectId) === entity) {
        this.boundEntities.delete(objectId);
      }
      if (this.climate === entity) {
        this.climate = null;
      }
    });

    if (entity.type === 'Climate') {
      if (this.climate) {
        // A device with several climate entities isn't something this plugin supports.
        this.options.log.warn(this.prefix(`Ignoring additional climate entity ${objectId}`));
        return;
      }
      this.climate = entity;
      this.climateConfig = entity.config as ClimateConfig;
      this.emit('climateConfig', this.climateConfig);
      entity.on('state', (state: ClimateState) => {
        if (entity !== this.climate) {
          return;
        }
        // Right after the controller boots it publishes a placeholder (mode Off,
        // NaN temperatures) until the AC answers its first status request.
        if (!Number.isFinite(state.targetTemperature)) {
          this.options.log.debug(this.prefix('Ignoring placeholder state; the AC has not reported yet'));
          return;
        }
        this.climateState = state;
        this.setAvailable(true);
        this.emit('climateState', state);
      });
      return;
    }

    this.entities.set(objectId, { type: entity.type, config: entity.config });
    entity.on('state', (state: { state: EntityValue; missingState?: boolean }) => {
      if (state.missingState) {
        this.entityStates.delete(objectId);
        return;
      }
      this.entityStates.set(objectId, state.state);
      this.emit('entityState', objectId, state.state);
    });
  }

  private setAvailable(available: boolean): void {
    if (this._available === available) {
      return;
    }
    this._available = available;
    this.emit('availability', available);
  }

  private prefix(message: string): string {
    return `[${this.options.name}] ${message}`;
  }
}
