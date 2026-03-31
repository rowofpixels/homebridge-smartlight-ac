import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type {
  ClimateEntity,
  ClimateStateResponse,
  ClimateCommandData,
} from '@2colors/esphome-native-api';
import { ClimateMode, ClimateFanMode, ClimateSwingMode, ClimateAction } from './esphome.js';
import type { SmartlightPlatform } from './platform.js';

// Debounce delay to batch rapid characteristic changes into a single command
const COMMAND_DEBOUNCE_MS = 600;

export class SmartlightAccessory {
  private readonly heaterCoolerService: Service;
  private readonly entity: ClimateEntity;
  private readonly minTemp: number;
  private readonly maxTemp: number;

  private lastState: ClimateStateResponse | null = null;
  private pendingCommand: Partial<ClimateCommandData> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Track the HomeKit-side target mode separately from the device mode.
  // The device always reports mode=1 (HeatCool) regardless of cool/heat/auto,
  // so we can't derive the HomeKit mode from device state.
  private homeKitTargetMode: number;

  constructor(
    private readonly platform: SmartlightPlatform,
    private readonly accessory: PlatformAccessory,
    entity: ClimateEntity,
  ) {
    this.entity = entity;
    this.homeKitTargetMode = this.platform.Characteristic.TargetHeaterCoolerState.AUTO;

    // Accessory information
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Smartlight')
      .setCharacteristic(this.platform.Characteristic.Model, 'SLWF-01pro')
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        entity.config.uniqueId || 'Unknown',
      );

    // HeaterCooler service
    this.heaterCoolerService =
      this.accessory.getService(this.platform.Service.HeaterCooler) ||
      this.accessory.addService(this.platform.Service.HeaterCooler, this.accessory.displayName);

    // Active (on/off)
    this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    // Current state (heating/cooling/idle)
    this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.getCurrentState.bind(this));

    // Target state (auto/heat/cool)
    this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .onGet(this.getTargetState.bind(this))
      .onSet(this.setTargetState.bind(this));

    // Current temperature
    this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    // Temperature thresholds
    this.minTemp = entity.config.visualMinTemperature || 17;
    this.maxTemp = entity.config.visualMaxTemperature || 30;
    const tempStep = entity.config.visualTemperatureStep || 0.5;

    const coolingChar = this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature);
    coolingChar.updateValue(this.minTemp);
    coolingChar.setProps({ minValue: this.minTemp, maxValue: this.maxTemp, minStep: tempStep });
    coolingChar.onGet(this.getCoolingThreshold.bind(this));
    coolingChar.onSet(this.setTargetTemperature.bind(this));

    const heatingChar = this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature);
    heatingChar.updateValue(this.minTemp);
    heatingChar.setProps({ minValue: this.minTemp, maxValue: this.maxTemp, minStep: tempStep });
    heatingChar.onGet(this.getHeatingThreshold.bind(this));
    heatingChar.onSet(this.setTargetTemperature.bind(this));

    // Swing mode
    if (entity.config.supportedSwingModesList?.length > 0) {
      this.heaterCoolerService
        .getCharacteristic(this.platform.Characteristic.SwingMode)
        .onGet(this.getSwingMode.bind(this))
        .onSet(this.setSwingMode.bind(this));
    }

    // Rotation speed (mapped from fan modes)
    if (entity.config.supportedFanModesList?.length > 0) {
      this.heaterCoolerService
        .getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
        .onGet(this.getRotationSpeed.bind(this))
        .onSet(this.setRotationSpeed.bind(this));
    }

    if (this.platform.debugMode) {
      this.platform.log.info(
        `[${this.accessory.displayName}] Supported modes: ${JSON.stringify(entity.config.supportedModesList)}`,
      );
    }

    // Listen for state updates from the device
    this.entity.on('state', (state: ClimateStateResponse) => {
      if (this.platform.debugMode) {
        this.platform.log.info(
          `[${this.accessory.displayName}] State: mode=${state.mode} action=${state.action} ` +
          `current=${state.currentTemperature}°C target=${state.targetTemperature}°C ` +
          `fan=${state.fanMode} swing=${state.swingMode}`,
        );
      }
      this.lastState = state;
      this.pushStateToHomeKit(state);
    });
  }

  // --- Getters ---

  private getActive(): CharacteristicValue {
    if (!this.lastState) {
      return this.platform.Characteristic.Active.INACTIVE;
    }
    return this.lastState.mode === ClimateMode.Off
      ? this.platform.Characteristic.Active.INACTIVE
      : this.platform.Characteristic.Active.ACTIVE;
  }

  private getCurrentState(): CharacteristicValue {
    if (!this.lastState) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }
    switch (this.lastState.action) {
      case ClimateAction.Cooling:
      case ClimateAction.Drying:
        return this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
      case ClimateAction.Heating:
        return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
      case ClimateAction.Idle:
      case ClimateAction.Fan:
        return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
      default:
        return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }
  }

  private getTargetState(): CharacteristicValue {
    return this.homeKitTargetMode;
  }

  private getCurrentTemperature(): CharacteristicValue {
    return this.lastState?.currentTemperature ?? 20;
  }

  private getCoolingThreshold(): CharacteristicValue {
    if (!this.lastState) {
      return this.minTemp;
    }
    if (this.homeKitTargetMode === this.platform.Characteristic.TargetHeaterCoolerState.HEAT) {
      return this.maxTemp;
    }
    return this.clampTemp(this.lastState.targetTemperature);
  }

  private getHeatingThreshold(): CharacteristicValue {
    if (!this.lastState) {
      return this.minTemp;
    }
    if (this.homeKitTargetMode === this.platform.Characteristic.TargetHeaterCoolerState.COOL) {
      return this.minTemp;
    }
    return this.clampTemp(this.lastState.targetTemperature);
  }

  private getSwingMode(): CharacteristicValue {
    if (!this.lastState || this.lastState.swingMode === ClimateSwingMode.Off) {
      return this.platform.Characteristic.SwingMode.SWING_DISABLED;
    }
    return this.platform.Characteristic.SwingMode.SWING_ENABLED;
  }

  private getRotationSpeed(): CharacteristicValue {
    if (!this.lastState) {
      return 0;
    }
    return this.fanModeToSpeed(this.lastState.fanMode);
  }

  // --- Setters ---

  private setActive(value: CharacteristicValue): void {
    if (value === this.platform.Characteristic.Active.INACTIVE) {
      this.sendCommand({ mode: ClimateMode.Off });
    } else {
      // Turn on — restore to last known target state or default to AUTO
      const targetState = this.heaterCoolerService.getCharacteristic(
        this.platform.Characteristic.TargetHeaterCoolerState,
      ).value;
      this.sendCommand({ mode: this.targetStateToClimateMode(targetState as number) });
    }
  }

  private setTargetState(value: CharacteristicValue): void {
    this.homeKitTargetMode = value as number;
    this.sendCommand({ mode: this.targetStateToClimateMode(value as number) });
  }

  private setTargetTemperature(value: CharacteristicValue): void {
    this.sendCommand({ targetTemperature: value as number });
  }

  private setSwingMode(value: CharacteristicValue): void {
    if (value === this.platform.Characteristic.SwingMode.SWING_ENABLED) {
      this.sendCommand({ swingMode: ClimateSwingMode.Vertical });
    } else {
      this.sendCommand({ swingMode: ClimateSwingMode.Off });
    }
  }

  private setRotationSpeed(value: CharacteristicValue): void {
    this.sendCommand({ fanMode: this.speedToFanMode(value as number) });
  }

  // --- Command batching ---

  private sendCommand(params: Omit<ClimateCommandData, 'key'>): void {
    this.pendingCommand = {
      ...this.pendingCommand,
      ...params,
    };

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      if (this.pendingCommand) {
        if (this.platform.debugMode) {
          this.platform.log.info('Sending command:', JSON.stringify(this.pendingCommand));
        }
        this.entity.command(this.pendingCommand);
        this.pendingCommand = null;
      }
    }, COMMAND_DEBOUNCE_MS);
  }

  // --- Push state updates to HomeKit ---

  private pushStateToHomeKit(state: ClimateStateResponse): void {
    const { Characteristic } = this.platform;

    const isActive = state.mode !== ClimateMode.Off;
    this.heaterCoolerService.updateCharacteristic(
      Characteristic.Active,
      isActive ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
    );

    this.heaterCoolerService.updateCharacteristic(
      Characteristic.CurrentHeaterCoolerState,
      this.getCurrentState(),
    );

    // Don't push TargetHeaterCoolerState — the device always reports mode=1
    // (HeatCool) regardless of cool/heat/auto, so pushing it would override
    // the user's selection. We track the mode on the HomeKit side instead.

    this.heaterCoolerService.updateCharacteristic(
      Characteristic.CurrentTemperature,
      state.currentTemperature,
    );

    // Set thresholds based on HomeKit-side mode to prevent collapsing to AUTO.
    // The device has a single target temperature, but HomeKit expects two thresholds.
    const target = this.clampTemp(state.targetTemperature);
    const { TargetHeaterCoolerState } = Characteristic;
    if (this.homeKitTargetMode === TargetHeaterCoolerState.COOL) {
      this.heaterCoolerService.updateCharacteristic(
        Characteristic.CoolingThresholdTemperature, target);
      this.heaterCoolerService.updateCharacteristic(
        Characteristic.HeatingThresholdTemperature, this.minTemp);
    } else if (this.homeKitTargetMode === TargetHeaterCoolerState.HEAT) {
      this.heaterCoolerService.updateCharacteristic(
        Characteristic.HeatingThresholdTemperature, target);
      this.heaterCoolerService.updateCharacteristic(
        Characteristic.CoolingThresholdTemperature, this.maxTemp);
    } else {
      this.heaterCoolerService.updateCharacteristic(
        Characteristic.CoolingThresholdTemperature, target);
      this.heaterCoolerService.updateCharacteristic(
        Characteristic.HeatingThresholdTemperature, target);
    }

    if (this.entity.config.supportedSwingModesList?.length > 0) {
      this.heaterCoolerService.updateCharacteristic(
        Characteristic.SwingMode,
        state.swingMode === ClimateSwingMode.Off
          ? Characteristic.SwingMode.SWING_DISABLED
          : Characteristic.SwingMode.SWING_ENABLED,
      );
    }

    if (this.entity.config.supportedFanModesList?.length > 0) {
      this.heaterCoolerService.updateCharacteristic(
        Characteristic.RotationSpeed,
        this.fanModeToSpeed(state.fanMode),
      );
    }
  }

  // --- Mapping helpers ---

  private targetStateToClimateMode(targetState: number): number {
    const { Characteristic } = this.platform;
    switch (targetState) {
      case Characteristic.TargetHeaterCoolerState.COOL:
        return ClimateMode.Cool;
      case Characteristic.TargetHeaterCoolerState.HEAT:
        return ClimateMode.Heat;
      default:
        return ClimateMode.HeatCool;
    }
  }

  private fanModeToSpeed(fanMode: number): number {
    switch (fanMode) {
      case ClimateFanMode.Low:
      case ClimateFanMode.Quiet:
        return 25;
      case ClimateFanMode.Medium:
      case ClimateFanMode.Middle:
        return 50;
      case ClimateFanMode.High:
      case ClimateFanMode.Focus:
        return 75;
      default:
        // Auto, On, Off, Diffuse
        return 0;
    }
  }

  private speedToFanMode(speed: number): number {
    if (speed <= 0) {
      return ClimateFanMode.Auto;
    } else if (speed <= 30) {
      return ClimateFanMode.Low;
    } else if (speed <= 60) {
      return ClimateFanMode.Medium;
    } else {
      return ClimateFanMode.High;
    }
  }

  private clampTemp(temp: number): number {
    return Math.max(this.minTemp, Math.min(this.maxTemp, temp));
  }
}
