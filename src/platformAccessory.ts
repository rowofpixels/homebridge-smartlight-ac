import type { Characteristic, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { AcDevice, EntityValue } from './device.js';
import { applyCommand, describeCommand, describeState } from './climate.js';
import {
  ClimateFanMode,
  ClimateMode,
  ClimatePreset,
  ClimateSwingMode,
  type ClimateConfig,
  type ClimateState,
  type DeviceInfo,
} from './esphome.js';
import {
  SWITCH_MODES,
  SWITCH_PRESETS,
  homeKitValues,
  isHeatCoolMode,
  manualFanModes,
  resolveCommand,
  targetStateToMode,
  targetStates,
  type HeatCoolMode,
  type HomeKitValues,
  type Intents,
} from './homekit.js';
import { PendingCommands } from './pending.js';
import type { SmartlightPlatform } from './platform.js';
import type { SmartlightDeviceConfig } from './settings.js';

// Collect HomeKit writes that arrive together (e.g. from a scene) into one command.
const COMMAND_DEBOUNCE_MS = 300;
// How long HomeKit shows a requested value before deferring to what the AC reports.
const CONFIRM_TIMEOUT_MS = 8000;

// Used until the device has reported its traits (e.g. it was offline at startup).
const DEFAULT_TRAITS: ClimateConfig = {
  objectId: '',
  key: 0,
  name: '',
  supportsCurrentTemperature: true,
  supportsTwoPointTargetTemperature: false,
  supportsAction: false,
  supportedModesList: [ClimateMode.Off, ClimateMode.Cool, ClimateMode.Heat],
  visualMinTemperature: 17,
  visualMaxTemperature: 30,
  visualTargetTemperatureStep: 0.5,
  supportedFanModesList: [ClimateFanMode.Auto, ClimateFanMode.Low, ClimateFanMode.Medium, ClimateFanMode.High],
  supportedCustomFanModesList: [],
  supportedSwingModesList: [],
  supportedPresetsList: [],
  supportedCustomPresetsList: [],
};

const SWING_SETTINGS = {
  vertical: ClimateSwingMode.Vertical,
  horizontal: ClimateSwingMode.Horizontal,
  both: ClimateSwingMode.Both,
} as const;

const MODE_SWITCHES: Record<number, { subtype: string; label: string }> = {
  [ClimateMode.Dry]: { subtype: 'dry', label: 'Dry' },
  [ClimateMode.FanOnly]: { subtype: 'fan-only', label: 'Fan Only' },
};

const PRESET_SWITCHES: Record<number, { subtype: string; label: string }> = {
  [ClimatePreset.Boost]: { subtype: 'boost', label: 'Boost' },
  [ClimatePreset.Sleep]: { subtype: 'sleep', label: 'Sleep' },
};

const OUTDOOR_SENSOR_SUBTYPE = 'outdoor';

export class SmartlightAccessory {
  private readonly heaterCooler: Service;
  private readonly modeSwitches = new Map<number, Service>();
  private readonly presetSwitches = new Map<number, Service>();
  private outdoorSensor: Service | undefined;
  private outdoorSensorId: string | undefined;

  private traits: ClimateConfig;
  /** Whether `traits` came from the device (now or cached), rather than defaults. */
  private traitsKnown: boolean;
  private lastHeatCoolMode: HeatCoolMode;
  private lastOnMode: number;
  private readonly pending = new PendingCommands(CONFIRM_TIMEOUT_MS);
  private intents: Intents = {};
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly platform: SmartlightPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: AcDevice,
    private readonly config: SmartlightDeviceConfig,
  ) {
    const { Characteristic, Service } = platform;
    const context = accessory.context;

    this.traits = context.traits ?? DEFAULT_TRAITS;
    this.traitsKnown = context.traits !== undefined;
    // `lastTargetMode` (a TargetHeaterCoolerState) is from versions ≤ 0.1.14.
    this.lastHeatCoolMode = context.lastHeatCoolMode
      ?? (context.lastTargetMode !== undefined ? targetStateToMode(context.lastTargetMode) : ClimateMode.Cool);
    this.lastOnMode = context.lastOnMode ?? this.lastHeatCoolMode;
    context.lastHeatCoolMode = this.lastHeatCoolMode;
    delete context.lastTargetMode;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Smartlight')
      .setCharacteristic(Characteristic.Model, 'SLWF-01pro')
      .setCharacteristic(Characteristic.SerialNumber, context.serialNumber ?? config.host);

    this.heaterCooler = accessory.getService(Service.HeaterCooler)
      ?? accessory.addService(Service.HeaterCooler, accessory.displayName);
    this.heaterCooler.setPrimaryService(true);

    const hc = this.heaterCooler;
    hc.getCharacteristic(Characteristic.Active)
      .onGet(() => this.read((v) => v.active))
      .onSet((value) => this.write('Active', value, { active: value as number }));
    hc.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.read((v) => v.currentState));
    hc.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .onGet(() => this.read((v) => v.targetState))
      .onSet((value) => {
        // Remember the choice even if it arrives with Active=0, so turning on later uses it.
        this.setLastHeatCoolMode(targetStateToMode(value as number));
        this.write('TargetHeaterCoolerState', value, { targetState: value as number });
      });
    hc.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.read((v) => v.currentTemperature));
    hc.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .onGet(() => this.read((v) => v.threshold))
      .onSet((value) => this.write('CoolingThresholdTemperature', value, { coolingThreshold: value as number }));
    hc.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .onGet(() => this.read((v) => v.threshold))
      .onSet((value) => this.write('HeatingThresholdTemperature', value, { heatingThreshold: value as number }));

    // A cached TemperatureSensor means the device had an outdoor sensor last time.
    this.outdoorSensor = accessory.getServiceById(Service.TemperatureSensor, OUTDOOR_SENSOR_SUBTYPE);
    if (this.outdoorSensor && config.outdoorTemperature === false) {
      accessory.removeService(this.outdoorSensor);
      this.outdoorSensor = undefined;
    }
    this.outdoorSensor?.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.readOutdoorTemperature());

    this.applyTraits(this.traits);

    device.on('climateConfig', (traits: ClimateConfig) => {
      this.traitsKnown = true;
      this.applyTraits(traits);
      context.traits = traits;
      this.saveContext();
    });
    device.on('climateState', (state: ClimateState) => this.onState(state));
    device.on('availability', (available: boolean) => this.onAvailability(available));
    device.on('entityState', (objectId: string, value: EntityValue) => this.onEntityState(objectId, value));
    device.on('deviceInfo', (info: DeviceInfo) => this.onDeviceInfo(info));
  }

  // --- Reading ---

  /** The values HomeKit should show: device state, plus commands in flight and writes not yet sent. */
  private currentValues(): HomeKitValues | null {
    const state = this.device.climateState;
    if (!state || !this.device.available) {
      return null;
    }
    const withPending = this.pending.apply(state);
    const withIntents = applyCommand(withPending, resolveCommand(this.intents, this.resolveContext(withPending)));
    return homeKitValues(withIntents, this.traits, this.lastHeatCoolMode);
  }

  private read<T extends CharacteristicValue>(pick: (values: HomeKitValues) => T): T {
    const values = this.currentValues();
    if (!values) {
      throw this.noResponse();
    }
    return pick(values);
  }

  private readOutdoorTemperature(): number {
    const value = this.outdoorSensorId ? this.device.entityStates.get(this.outdoorSensorId) : undefined;
    if (!this.device.available || typeof value !== 'number' || !Number.isFinite(value)) {
      throw this.noResponse();
    }
    return value;
  }

  private noResponse(): Error {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  // --- Writing ---

  private write(characteristic: string, value: CharacteristicValue, intent: Intents): void {
    this.debug(`HomeKit set ${characteristic}=${value}`);
    if (!this.device.available) {
      throw this.noResponse();
    }
    this.intents = mergeIntents(this.intents, intent);
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), COMMAND_DEBOUNCE_MS);
  }

  private flush(): void {
    this.debounceTimer = undefined;
    const intents = this.intents;
    this.intents = {};

    const state = this.device.climateState;
    if (!state || !this.device.available) {
      this.platform.log.warn(`[${this.accessory.displayName}] Device unavailable; HomeKit change not sent`);
      return;
    }
    const base = this.pending.apply(state);
    const command = resolveCommand(intents, this.resolveContext(base));
    if (Object.keys(command).length === 0) {
      this.debug('Nothing to change');
    } else {
      this.debug(`Sending ${describeCommand(command)}`);
      if (this.device.sendClimateCommand(command)) {
        this.pending.add(command, Date.now());
        this.scheduleDeadline();
      }
    }
    this.pushValues();
  }

  private resolveContext(state: ClimateState) {
    const preferred = SWING_SETTINGS[this.config.swing ?? 'vertical'];
    const supportedSwing = this.traits.supportedSwingModesList.filter((m) => m !== ClimateSwingMode.Off);
    return {
      state,
      traits: this.traits,
      lastHeatCoolMode: this.lastHeatCoolMode,
      lastOnMode: this.lastOnMode,
      swingMode: supportedSwing.includes(preferred) ? preferred : (supportedSwing[0] ?? preferred),
    };
  }

  // --- Device events ---

  private onState(state: ClimateState): void {
    this.debug(`Device state: ${describeState(state)}`);
    this.reportExpired(this.pending.settle(state, Date.now()));
    this.scheduleDeadline();

    const effective = this.pending.apply(state);
    if (isHeatCoolMode(effective.mode)) {
      this.setLastHeatCoolMode(effective.mode);
    }
    if (effective.mode !== ClimateMode.Off && effective.mode !== this.lastOnMode) {
      this.lastOnMode = effective.mode;
      this.accessory.context.lastOnMode = effective.mode;
      this.saveContext();
    }
    this.pushValues();
  }

  private onAvailability(available: boolean): void {
    if (available) {
      this.pushValues();
      return;
    }
    // Anything in flight is moot; show "No Response" until the device is back.
    this.pending.clear();
    clearTimeout(this.deadlineTimer);
    this.heaterCooler.updateCharacteristic(this.platform.Characteristic.Active, this.noResponse());
  }

  private onEntityState(objectId: string, value: EntityValue): void {
    const entity = this.device.entities.get(objectId);
    const isOutdoorTemperature = entity?.type === 'Sensor' && entity.config.deviceClass === 'temperature' &&
      /outdoor/i.test(objectId);
    if (!isOutdoorTemperature || this.config.outdoorTemperature === false) {
      return;
    }
    this.outdoorSensorId = objectId;
    if (!this.outdoorSensor) {
      const { Service, Characteristic } = this.platform;
      const name = `${this.accessory.displayName} Outdoor`;
      this.outdoorSensor = this.accessory.addService(Service.TemperatureSensor, name, OUTDOOR_SENSOR_SUBTYPE);
      this.outdoorSensor.addOptionalCharacteristic(Characteristic.ConfiguredName);
      this.outdoorSensor.setCharacteristic(Characteristic.ConfiguredName, name);
      this.outdoorSensor.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: -50, maxValue: 70 })
        .onGet(() => this.readOutdoorTemperature());
      this.heaterCooler.addLinkedService(this.outdoorSensor);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      this.outdoorSensor.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, value);
    }
  }

  private onDeviceInfo(info: DeviceInfo): void {
    const { Characteristic, Service } = this.platform;
    const serialNumber = info.macAddress || this.config.host;
    this.accessory.getService(Service.AccessoryInformation)!
      .updateCharacteristic(Characteristic.SerialNumber, serialNumber)
      .updateCharacteristic(Characteristic.FirmwareRevision, info.esphomeVersion);
    if (this.accessory.context.serialNumber !== serialNumber) {
      this.accessory.context.serialNumber = serialNumber;
      this.saveContext();
    }
  }

  // --- Pushing to HomeKit ---

  private pushValues(): void {
    const values = this.currentValues();
    if (!values) {
      return;
    }
    const { Characteristic } = this.platform;
    const hc = this.heaterCooler;
    hc.updateCharacteristic(Characteristic.Active, values.active);
    hc.updateCharacteristic(Characteristic.CurrentHeaterCoolerState, values.currentState);
    hc.updateCharacteristic(Characteristic.TargetHeaterCoolerState, values.targetState);
    if (Number.isFinite(values.currentTemperature)) {
      hc.updateCharacteristic(Characteristic.CurrentTemperature, values.currentTemperature);
    }
    hc.updateCharacteristic(Characteristic.CoolingThresholdTemperature, values.threshold);
    hc.updateCharacteristic(Characteristic.HeatingThresholdTemperature, values.threshold);
    if (hc.testCharacteristic(Characteristic.RotationSpeed)) {
      hc.updateCharacteristic(Characteristic.RotationSpeed, values.rotationSpeed);
    }
    if (hc.testCharacteristic(Characteristic.SwingMode)) {
      hc.updateCharacteristic(Characteristic.SwingMode, values.swing);
    }
    for (const [mode, service] of this.modeSwitches) {
      service.updateCharacteristic(Characteristic.On, values.modeSwitches.get(mode) ?? false);
    }
    for (const [preset, service] of this.presetSwitches) {
      service.updateCharacteristic(Characteristic.On, values.presetSwitches.get(preset) ?? false);
    }
  }

  // --- Traits ---

  /** Set characteristic ranges and add/remove optional parts to match what the device supports. */
  private applyTraits(traits: ClimateConfig): void {
    this.traits = traits;
    const { Characteristic, Service } = this.platform;
    const hc = this.heaterCooler;
    // Until the device has reported its traits, keep what's already there: removing and
    // re-adding a characteristic or service would give it a new ID in HomeKit.
    const keep = (supported: boolean, exists: boolean) => supported || (!this.traitsKnown && exists);

    hc.getCharacteristic(Characteristic.TargetHeaterCoolerState).setProps({ validValues: targetStates(traits) });
    const range = {
      minValue: traits.visualMinTemperature,
      maxValue: traits.visualMaxTemperature,
      minStep: traits.visualTargetTemperatureStep || 0.5,
    };
    hc.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps(range);
    hc.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps(range);

    const fanModes = manualFanModes(traits);
    const hasFanModes = keep(fanModes.length > 0, hc.testCharacteristic(Characteristic.RotationSpeed));
    this.toggleCharacteristic(Characteristic.RotationSpeed, hasFanModes, (c) => c
      .setProps({ minValue: 0, maxValue: 100, minStep: 100 / Math.max(1, fanModes.length) })
      .onGet(() => this.read((v) => v.rotationSpeed))
      .onSet((value) => this.write('RotationSpeed', value, { rotationSpeed: value as number })));

    const hasSwing = keep(traits.supportedSwingModesList.some((m) => m !== ClimateSwingMode.Off),
      hc.testCharacteristic(Characteristic.SwingMode));
    this.toggleCharacteristic(Characteristic.SwingMode, hasSwing, (c) => c
      .onGet(() => this.read((v) => v.swing))
      .onSet((value) => this.write('SwingMode', value, { swing: value as number })));

    for (const mode of SWITCH_MODES) {
      const enabled = (mode === ClimateMode.Dry ? this.config.dryModeSwitch : this.config.fanOnlySwitch) !== false;
      const exists = this.accessory.getServiceById(Service.Switch, MODE_SWITCHES[mode].subtype) !== undefined;
      const wanted = enabled && keep(traits.supportedModesList.includes(mode), exists);
      this.toggleSwitch(this.modeSwitches, mode, MODE_SWITCHES[mode], wanted,
        (v) => v.modeSwitches.get(mode) ?? false,
        (on) => ({ modeSwitches: new Map([[mode, on]]) }));
    }
    for (const preset of SWITCH_PRESETS) {
      const exists = this.accessory.getServiceById(Service.Switch, PRESET_SWITCHES[preset].subtype) !== undefined;
      const wanted = this.config.presetSwitches === true && keep(traits.supportedPresetsList.includes(preset), exists);
      this.toggleSwitch(this.presetSwitches, preset, PRESET_SWITCHES[preset], wanted,
        (v) => v.presetSwitches.get(preset) ?? false,
        (on) => ({ presetSwitches: new Map([[preset, on]]) }));
    }

    this.pushValues();
  }

  private toggleCharacteristic(
    type: typeof Characteristic.RotationSpeed | typeof Characteristic.SwingMode,
    wanted: boolean,
    configure: (c: Characteristic) => void,
  ): void {
    const hc = this.heaterCooler;
    if (wanted) {
      configure(hc.getCharacteristic(type));
    } else if (hc.testCharacteristic(type)) {
      hc.removeCharacteristic(hc.getCharacteristic(type));
    }
  }

  private toggleSwitch(
    services: Map<number, Service>,
    key: number,
    { subtype, label }: { subtype: string; label: string },
    wanted: boolean,
    read: (values: HomeKitValues) => boolean,
    intent: (on: boolean) => Intents,
  ): void {
    const { Service, Characteristic } = this.platform;
    let service = this.accessory.getServiceById(Service.Switch, subtype);
    if (!wanted) {
      if (service) {
        this.accessory.removeService(service);
      }
      services.delete(key);
      return;
    }
    if (!service) {
      const name = `${this.accessory.displayName} ${label}`;
      service = this.accessory.addService(Service.Switch, name, subtype);
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
      service.setCharacteristic(Characteristic.ConfiguredName, name);
      this.heaterCooler.addLinkedService(service);
    }
    service.getCharacteristic(Characteristic.On)
      .onGet(() => this.read(read))
      .onSet((value) => this.write(`${label} switch`, value, intent(value as boolean)));
    services.set(key, service);
  }

  // --- Helpers ---

  private scheduleDeadline(): void {
    clearTimeout(this.deadlineTimer);
    const next = this.pending.nextDeadline();
    if (next === undefined) {
      return;
    }
    // The AC only reports changes, so a rejected command produces no state update; check on a timer.
    this.deadlineTimer = setTimeout(() => {
      const state = this.device.climateState;
      if (state) {
        this.reportExpired(this.pending.settle(state, Date.now()));
      }
      this.scheduleDeadline();
      this.pushValues();
    }, Math.max(0, next - Date.now()) + 10);
  }

  private reportExpired(expired: ReturnType<PendingCommands['settle']>): void {
    const state = this.device.climateState;
    for (const { field, requested } of expired) {
      this.platform.log.info(
        `[${this.accessory.displayName}] The AC did not apply ${describeCommand({ [field]: requested })}` +
        (state ? ` (it reports ${describeState(state)})` : ''),
      );
    }
  }

  private setLastHeatCoolMode(mode: HeatCoolMode): void {
    if (mode !== this.lastHeatCoolMode) {
      this.lastHeatCoolMode = mode;
      this.accessory.context.lastHeatCoolMode = mode;
      this.saveContext();
    }
  }

  private saveContext(): void {
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  private debug(message: string): void {
    const text = `[${this.accessory.displayName}] ${message}`;
    if (this.platform.debugMode) {
      this.platform.log.info(text);
    } else {
      this.platform.log.debug(text);
    }
  }
}

function mergeIntents(current: Intents, update: Intents): Intents {
  return {
    ...current,
    ...update,
    modeSwitches: mergeMaps(current.modeSwitches, update.modeSwitches),
    presetSwitches: mergeMaps(current.presetSwitches, update.presetSwitches),
  };
}

function mergeMaps<K, V>(a?: Map<K, V>, b?: Map<K, V>): Map<K, V> | undefined {
  if (!a || !b) {
    return a ?? b;
  }
  return new Map([...a, ...b]);
}
