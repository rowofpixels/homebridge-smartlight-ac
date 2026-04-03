import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { SmartlightAccessory } from '../src/platformAccessory.js';
import { ClimateMode, ClimateAction, ClimateFanMode, ClimateSwingMode } from '../src/esphome.js';

// ---- HAP Characteristic Constants (matching Homebridge spec values) ----

const Active = { ACTIVE: 1, INACTIVE: 0 } as const;
const CurrentHeaterCoolerState = { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 } as const;
const TargetHeaterCoolerState = { AUTO: 0, HEAT: 1, COOL: 2 } as const;
const CurrentTemperature = {} as const;
const CoolingThresholdTemperature = {} as const;
const HeatingThresholdTemperature = {} as const;
const SwingMode = { SWING_DISABLED: 0, SWING_ENABLED: 1 } as const;
const RotationSpeed = {} as const;
const Manufacturer = Symbol('Manufacturer');
const Model = Symbol('Model');
const SerialNumber = Symbol('SerialNumber');

// ---- Mock Infrastructure ----

class MockCharacteristic {
  value: any = null;
  private _onGet?: () => any;
  private _onSet?: (value: any) => void;

  onGet(handler: () => any): this { this._onGet = handler; return this; }
  onSet(handler: (value: any) => void): this { this._onSet = handler; return this; }
  setProps(): this { return this; }
  updateValue(value: any): this { this.value = value; return this; }

  /** Simulate HomeKit writing a value (HAP updates .value before calling onSet) */
  simulateSet(value: any): void {
    this.value = value;
    this._onSet?.(value);
  }

  /** Simulate HomeKit reading a value */
  simulateGet(): any {
    return this._onGet?.();
  }
}

class MockService {
  private chars = new Map<any, MockCharacteristic>();
  updates: Array<{ type: any; value: any }> = [];

  getCharacteristic(type: any): MockCharacteristic {
    if (!this.chars.has(type)) {
      this.chars.set(type, new MockCharacteristic());
    }
    return this.chars.get(type)!;
  }

  updateCharacteristic(type: any, value: any): this {
    this.updates.push({ type, value });
    const char = this.chars.get(type);
    if (char) char.value = value;
    return this;
  }

  setCharacteristic(): this { return this; }

  clearUpdates(): void { this.updates = []; }

  /** Get the most recent updateCharacteristic value for a type */
  lastUpdate(type: any): any {
    for (let i = this.updates.length - 1; i >= 0; i--) {
      if (this.updates[i].type === type) return this.updates[i].value;
    }
    return undefined;
  }
}

class MockEntity extends EventEmitter {
  config = {
    uniqueId: 'test-device-123',
    visualMinTemperature: 17,
    visualMaxTemperature: 30,
    visualTemperatureStep: 0.5,
    supportedSwingModesList: [0, 2],
    supportedFanModesList: [2, 3, 4, 5],
    supportedModesList: [0, 1, 2, 3],
  };

  commands: any[] = [];

  command(data: any): void { this.commands.push({ ...data }); }
  lastCommand(): any { return this.commands[this.commands.length - 1]; }
  clearCommands(): void { this.commands = []; }
}

// ---- Test Harness ----

interface Harness {
  entity: MockEntity;
  service: MockService;
  context: Record<string, any>;

  setActive(value: number): void;
  setTargetState(value: number): void;
  setHeatingTemp(value: number): void;
  setCoolingTemp(value: number): void;
  setSwingMode(value: number): void;
  setRotationSpeed(value: number): void;

  getActive(): any;
  getTargetState(): any;
  getHeatingThreshold(): any;
  getCoolingThreshold(): any;

  /** Emit a device state update (with sensible defaults) */
  deviceState(overrides?: Partial<{
    mode: number;
    action: number;
    currentTemperature: number;
    targetTemperature: number;
    fanMode: number;
    swingMode: number;
  }>): void;

  /** Advance time past the debounce window so the batched command fires */
  flush(): void;
}

function createHarness(savedContext: Record<string, any> = {}): Harness {
  const service = new MockService();
  const infoService = new MockService();
  const entity = new MockEntity();
  const context: Record<string, any> = { ...savedContext };

  const accessory = {
    getService(type: any) {
      if (type === 'AccessoryInformation') return infoService;
      if (type === 'HeaterCooler') return service;
      return undefined;
    },
    addService() { return service; },
    context,
    displayName: 'Test AC',
  };

  const platform = {
    Characteristic: {
      Active,
      CurrentHeaterCoolerState,
      TargetHeaterCoolerState,
      CurrentTemperature,
      CoolingThresholdTemperature,
      HeatingThresholdTemperature,
      SwingMode,
      RotationSpeed,
      Manufacturer,
      Model,
      SerialNumber,
    },
    Service: {
      AccessoryInformation: 'AccessoryInformation' as any,
      HeaterCooler: 'HeaterCooler' as any,
    },
    log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    debugMode: false,
  };

  new SmartlightAccessory(platform as any, accessory as any, entity as any);

  return {
    entity,
    service,
    context,

    setActive: (v) => service.getCharacteristic(Active).simulateSet(v),
    setTargetState: (v) => service.getCharacteristic(TargetHeaterCoolerState).simulateSet(v),
    setHeatingTemp: (v) => service.getCharacteristic(HeatingThresholdTemperature).simulateSet(v),
    setCoolingTemp: (v) => service.getCharacteristic(CoolingThresholdTemperature).simulateSet(v),
    setSwingMode: (v) => service.getCharacteristic(SwingMode).simulateSet(v),
    setRotationSpeed: (v) => service.getCharacteristic(RotationSpeed).simulateSet(v),

    getActive: () => service.getCharacteristic(Active).simulateGet(),
    getTargetState: () => service.getCharacteristic(TargetHeaterCoolerState).simulateGet(),
    getHeatingThreshold: () => service.getCharacteristic(HeatingThresholdTemperature).simulateGet(),
    getCoolingThreshold: () => service.getCharacteristic(CoolingThresholdTemperature).simulateGet(),

    deviceState: (overrides = {}) => entity.emit('state', {
      mode: ClimateMode.HeatCool,
      action: ClimateAction.Idle,
      currentTemperature: 22,
      targetTemperature: 24,
      fanMode: ClimateFanMode.Auto,
      swingMode: ClimateSwingMode.Off,
      ...overrides,
    }),

    flush: () => vi.advanceTimersByTime(600),
  };
}

// ---- Tests ----

describe('SmartlightAccessory', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // ============================================================
  // THE BUG: "Heat 75" from Off should not become "Auto 75-75"
  // ============================================================

  describe('the bug: Heat 75 from Off should not become Auto 75-75', () => {
    it('sends Heat 75 when setActive fires before setTargetState', () => {
      const h = createHarness();

      // HomeKit fires these in rapid succession (Active first)
      h.setActive(Active.ACTIVE);
      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.setHeatingTemp(75);
      h.flush();

      expect(h.entity.commands).toHaveLength(1);
      expect(h.entity.lastCommand()).toMatchObject({
        mode: ClimateMode.Heat,
        targetTemperature: 75,
      });
    });

    it('sends Heat 75 when setTargetState fires before setActive', () => {
      const h = createHarness();

      // HomeKit fires these in the opposite order
      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.setActive(Active.ACTIVE);
      h.setHeatingTemp(75);
      h.flush();

      expect(h.entity.commands).toHaveLength(1);
      expect(h.entity.lastCommand()).toMatchObject({
        mode: ClimateMode.Heat,
        targetTemperature: 75,
      });
    });

    it('pushes HEAT (not device HeatCool) as TargetHeaterCoolerState after device responds', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.flush();
      h.service.clearUpdates();

      // Device always reports mode=HeatCool regardless of actual mode
      h.deviceState({ mode: ClimateMode.HeatCool, targetTemperature: 75 });

      expect(h.service.lastUpdate(TargetHeaterCoolerState)).toBe(TargetHeaterCoolerState.HEAT);
    });

    it('sets spread thresholds (heating=75, cooling=max) for HEAT mode', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.flush();
      h.service.clearUpdates();

      h.deviceState({ targetTemperature: 25 });

      expect(h.service.lastUpdate(HeatingThresholdTemperature)).toBe(25);
      expect(h.service.lastUpdate(CoolingThresholdTemperature)).toBe(30); // maxTemp
    });
  });

  // ============================================================
  // Turning on from Off
  // ============================================================

  describe('turning on from off', () => {
    it('restores last mode when only setActive fires (no setTargetState)', () => {
      const h = createHarness();

      // User previously selected Heat
      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.flush();
      h.entity.clearCommands();

      // User turns off
      h.setActive(Active.INACTIVE);
      h.flush();
      h.entity.clearCommands();

      // User toggles back on (no mode change — HomeKit only sends setActive)
      h.setActive(Active.ACTIVE);
      h.flush();

      expect(h.entity.lastCommand()).toMatchObject({
        mode: ClimateMode.Heat,
      });
    });

    it('uses homeKitTargetMode, not characteristic cache, when activating', () => {
      // This is the core fix: setActive reads homeKitTargetMode (always correct)
      // instead of the characteristic's cached .value (can be stale)
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.COOL);
      h.flush();
      h.entity.clearCommands();

      h.setActive(Active.ACTIVE);
      h.flush();

      expect(h.entity.lastCommand()).toMatchObject({
        mode: ClimateMode.Cool,
      });
    });

    it('handles rapid Off -> On toggle correctly', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.flush();
      h.entity.clearCommands();

      // Rapid toggle: off then immediately on within debounce window
      h.setActive(Active.INACTIVE);
      h.setActive(Active.ACTIVE);
      h.flush();

      // Last call wins: device should be in Heat mode
      expect(h.entity.commands).toHaveLength(1);
      expect(h.entity.lastCommand()).toMatchObject({
        mode: ClimateMode.Heat,
      });
    });
  });

  // ============================================================
  // Turning off
  // ============================================================

  describe('turning off', () => {
    it('sends Off mode when setActive(INACTIVE)', () => {
      const h = createHarness();

      h.setActive(Active.INACTIVE);
      h.flush();

      expect(h.entity.lastCommand()).toMatchObject({
        mode: ClimateMode.Off,
      });
    });
  });

  // ============================================================
  // Mode changes while active
  // ============================================================

  describe('mode changes while active', () => {
    it('switches from Auto to Heat', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.flush();

      expect(h.entity.lastCommand()).toMatchObject({
        mode: ClimateMode.Heat,
      });
    });

    it('switches from Heat to Cool', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.flush();
      h.entity.clearCommands();

      h.setTargetState(TargetHeaterCoolerState.COOL);
      h.flush();

      expect(h.entity.lastCommand()).toMatchObject({
        mode: ClimateMode.Cool,
      });
    });

    it('temperature change does not override mode', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.setHeatingTemp(25);
      h.flush();

      expect(h.entity.lastCommand()).toMatchObject({
        mode: ClimateMode.Heat,
        targetTemperature: 25,
      });
    });
  });

  // ============================================================
  // Command batching / debounce
  // ============================================================

  describe('command batching', () => {
    it('batches rapid changes into a single command', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.COOL);
      h.setCoolingTemp(22);
      h.setRotationSpeed(50);
      h.flush();

      expect(h.entity.commands).toHaveLength(1);
      expect(h.entity.lastCommand()).toMatchObject({
        mode: ClimateMode.Cool,
        targetTemperature: 22,
        fanMode: ClimateFanMode.Medium,
      });
    });

    it('does not send command before debounce fires', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);
      vi.advanceTimersByTime(500); // < 600ms

      expect(h.entity.commands).toHaveLength(0);
    });

    it('sends command after debounce delay', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.flush();

      expect(h.entity.commands).toHaveLength(1);
    });

    it('resets debounce timer on each new change', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);
      vi.advanceTimersByTime(500);
      // Add temperature within original debounce window — timer resets
      h.setHeatingTemp(25);
      vi.advanceTimersByTime(500);

      // 1000ms total but only 500ms since last change — no command yet
      expect(h.entity.commands).toHaveLength(0);

      vi.advanceTimersByTime(100); // Now 600ms since last change
      expect(h.entity.commands).toHaveLength(1);
    });

    it('later values override earlier values for the same field', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.setTargetState(TargetHeaterCoolerState.COOL);
      h.flush();

      expect(h.entity.lastCommand()).toMatchObject({
        mode: ClimateMode.Cool,
      });
    });
  });

  // ============================================================
  // Mode persistence across restarts
  // ============================================================

  describe('mode persistence', () => {
    it('saves mode to accessory.context when mode changes', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);

      expect(h.context.lastTargetMode).toBe(TargetHeaterCoolerState.HEAT);
    });

    it('restores mode from accessory.context on construction', () => {
      const h = createHarness({ lastTargetMode: TargetHeaterCoolerState.COOL });

      // getTargetState should return the persisted mode
      expect(h.getTargetState()).toBe(TargetHeaterCoolerState.COOL);
    });

    it('restores persisted mode when activating after restart', () => {
      // Simulates: user had HEAT, homebridge restarted, user toggles power
      const h = createHarness({ lastTargetMode: TargetHeaterCoolerState.HEAT });

      h.setActive(Active.ACTIVE);
      h.flush();

      expect(h.entity.lastCommand()).toMatchObject({
        mode: ClimateMode.Heat,
      });
    });

    it('defaults to AUTO when no saved mode exists', () => {
      const h = createHarness();

      expect(h.getTargetState()).toBe(TargetHeaterCoolerState.AUTO);
    });
  });

  // ============================================================
  // Device state updates pushed to HomeKit
  // ============================================================

  describe('state updates to HomeKit', () => {
    it('pushes Active based on device mode', () => {
      const h = createHarness();

      h.deviceState({ mode: ClimateMode.HeatCool });
      expect(h.service.lastUpdate(Active)).toBe(Active.ACTIVE);

      h.service.clearUpdates();
      h.deviceState({ mode: ClimateMode.Off });
      expect(h.service.lastUpdate(Active)).toBe(Active.INACTIVE);
    });

    it('pushes homeKitTargetMode as TargetHeaterCoolerState', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.COOL);
      h.flush();
      h.service.clearUpdates();

      h.deviceState();

      expect(h.service.lastUpdate(TargetHeaterCoolerState)).toBe(TargetHeaterCoolerState.COOL);
    });

    it('does not let device mode=HeatCool override user mode selection', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.flush();
      h.service.clearUpdates();

      // Device always reports HeatCool, but we should push HEAT
      h.deviceState({ mode: ClimateMode.HeatCool });

      expect(h.service.lastUpdate(TargetHeaterCoolerState)).toBe(TargetHeaterCoolerState.HEAT);
    });

    it('spreads thresholds in HEAT mode: heating=target, cooling=maxTemp', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.flush();
      h.service.clearUpdates();

      h.deviceState({ targetTemperature: 25 });

      expect(h.service.lastUpdate(HeatingThresholdTemperature)).toBe(25);
      expect(h.service.lastUpdate(CoolingThresholdTemperature)).toBe(30);
    });

    it('spreads thresholds in COOL mode: cooling=target, heating=minTemp', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.COOL);
      h.flush();
      h.service.clearUpdates();

      h.deviceState({ targetTemperature: 25 });

      expect(h.service.lastUpdate(CoolingThresholdTemperature)).toBe(25);
      expect(h.service.lastUpdate(HeatingThresholdTemperature)).toBe(17);
    });

    it('sets equal thresholds in AUTO mode', () => {
      const h = createHarness(); // defaults to AUTO

      h.deviceState({ targetTemperature: 25 });

      expect(h.service.lastUpdate(CoolingThresholdTemperature)).toBe(25);
      expect(h.service.lastUpdate(HeatingThresholdTemperature)).toBe(25);
    });

    it('clamps target temperature to min/max range', () => {
      const h = createHarness();

      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.flush();
      h.service.clearUpdates();

      // Target below min (17)
      h.deviceState({ targetTemperature: 10 });
      expect(h.service.lastUpdate(HeatingThresholdTemperature)).toBe(17);

      h.service.clearUpdates();

      // Target above max (30)
      h.deviceState({ targetTemperature: 40 });
      expect(h.service.lastUpdate(HeatingThresholdTemperature)).toBe(30);
    });
  });

  // ============================================================
  // Getters
  // ============================================================

  describe('getters', () => {
    it('getActive returns INACTIVE before first state update', () => {
      const h = createHarness();
      expect(h.getActive()).toBe(Active.INACTIVE);
    });

    it('getActive returns ACTIVE when device is on', () => {
      const h = createHarness();
      h.deviceState({ mode: ClimateMode.Heat });
      expect(h.getActive()).toBe(Active.ACTIVE);
    });

    it('getTargetState returns homeKitTargetMode', () => {
      const h = createHarness();
      h.setTargetState(TargetHeaterCoolerState.COOL);
      expect(h.getTargetState()).toBe(TargetHeaterCoolerState.COOL);
    });

    it('getHeatingThreshold returns minTemp in COOL mode', () => {
      const h = createHarness();
      h.setTargetState(TargetHeaterCoolerState.COOL);
      h.flush();
      h.deviceState({ targetTemperature: 25 });
      expect(h.getHeatingThreshold()).toBe(17); // minTemp
    });

    it('getCoolingThreshold returns maxTemp in HEAT mode', () => {
      const h = createHarness();
      h.setTargetState(TargetHeaterCoolerState.HEAT);
      h.flush();
      h.deviceState({ targetTemperature: 25 });
      expect(h.getCoolingThreshold()).toBe(30); // maxTemp
    });
  });
});
