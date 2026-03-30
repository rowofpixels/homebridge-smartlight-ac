import '@2colors/esphome-native-api';

// Augment the package's incomplete type declarations with the Client events,
// Entity types, and ClimateAction enum that are missing from the shipped index.d.ts.
declare module '@2colors/esphome-native-api' {
  export enum ClimateAction {
    Off = 0,
    Cooling = 2,
    Heating = 3,
    Idle = 4,
    Drying = 5,
    Fan = 6,
  }

  export interface ClimateStateResponse {
    key: number;
    mode: ClimateMode;
    action: ClimateAction;
    fanMode: ClimateFanMode;
    swingMode: ClimateSwingMode;
    preset: ClimatePreset;
    targetTemperature: number;
    currentTemperature: number;
    targetTemperatureLow: number;
    targetTemperatureHigh: number;
    customFanMode: string;
    customPreset: string;
  }

  export interface SensorStateResponse {
    key: number;
    state: number;
    missingState: boolean;
  }

  export interface ClimateEntity extends NodeJS.EventEmitter {
    type: 'Climate';
    name: string;
    id: number;
    config: ListEntitiesClimateResponse;
    connection: Connection;
    state: ClimateStateResponse;
    command(data: Omit<ClimateCommandData, 'key'>): void;
    on(event: 'state', listener: (state: ClimateStateResponse) => void): this;
    on(event: 'destroyed', listener: () => void): this;
  }

  export interface SensorEntity extends NodeJS.EventEmitter {
    type: 'Sensor';
    name: string;
    id: number;
    config: ListEntitiesSensorResponse;
    connection: Connection;
    state: SensorStateResponse;
    on(event: 'state', listener: (state: SensorStateResponse) => void): this;
    on(event: 'destroyed', listener: () => void): this;
  }

  export type Entity = ClimateEntity | SensorEntity | GenericEntity;

  export interface GenericEntity extends NodeJS.EventEmitter {
    type: string;
    name: string;
    id: number;
    config: ListEntitiesEntityResponse;
    connection: Connection;
  }

  // Augment the Client class with missing methods and events
  interface Client {
    connection: Connection;
    connected: boolean;
    initialized: boolean;
    deviceInfo: DeviceInfoResponse | null;
    entities: Record<number, Entity>;

    connect(): void;
    disconnect(): void;

    on(event: 'newEntity', listener: (entity: Entity) => void): this;
    on(event: 'connected', listener: () => void): this;
    on(event: 'disconnected', listener: () => void): this;
    on(event: 'initialized', listener: () => void): this;
    on(event: 'deviceInfo', listener: (info: DeviceInfoResponse) => void): this;
    on(event: 'logs', listener: (data: SubscribeLogsResponse) => void): this;
  }
}
