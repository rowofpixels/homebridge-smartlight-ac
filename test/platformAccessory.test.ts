import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as hap from '@homebridge/hap-nodejs';
import {
  Accessory,
  Characteristic,
  HAPStatus,
  Service,
  uuid,
  type CharacteristicValue,
  type WithUUID,
} from '@homebridge/hap-nodejs';
import { SmartlightAccessory } from '../src/platformAccessory.js';
import { ClimateFanMode, ClimateMode, ClimateSwingMode } from '../src/esphome.js';
import type { SmartlightDeviceConfig } from '../src/settings.js';
import { FakeDevice, climateState, fahrenheitToCelsius, traits } from './helpers.js';

const { Active, TargetHeaterCoolerState, CurrentHeaterCoolerState, SwingMode } = Characteristic;
type CharacteristicType = WithUUID<new () => Characteristic>;

function createHarness(options: {
  context?: Record<string, unknown>;
  config?: Partial<SmartlightDeviceConfig>;
  /** Set up the accessory as Homebridge would restore it from its cache. */
  cached?: (accessory: Accessory) => void;
} = {}) {
  const context = { ...options.context };
  const accessory = Object.assign(new Accessory('Mr. Cool', uuid.generate('test')), { context });
  options.cached?.(accessory);
  const device = new FakeDevice();
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const platform = {
    Service,
    Characteristic,
    log,
    debugMode: false,
    api: { hap, updatePlatformAccessories: vi.fn() },
  };
  new SmartlightAccessory(platform as never, accessory as never, device as never,
    { name: 'Mr. Cool', host: 'ac', ...options.config });
  const heaterCooler = accessory.getService(Service.HeaterCooler)!;
  const characteristic = (type: CharacteristicType) => heaterCooler.getCharacteristic(type);

  return {
    accessory,
    context,
    device,
    log,
    characteristic,
    /** One HAP write request; iOS often sends several characteristics together. */
    write: (...writes: Array<[CharacteristicType, CharacteristicValue]>) =>
      Promise.all(writes.map(([type, value]) => characteristic(type).handleSetRequest(value))),
    read: (type: CharacteristicType) => characteristic(type).handleGetRequest(),
    /** The value HomeKit was last told about (pushed by the plugin or written by HomeKit). */
    shown: (type: CharacteristicType) => characteristic(type).value,
    flush: () => vi.advanceTimersByTimeAsync(300),
    switchService: (subtype: string) => accessory.getServiceById(Service.Switch, subtype),
  };
}

describe('SmartlightAccessory', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe('showing device state', () => {
    it('shows the mode the AC reports', async () => {
      const h = createHarness();
      h.device.connect(climateState({ mode: ClimateMode.Cool }));

      expect(await h.read(Active)).toBe(Active.ACTIVE);
      expect(await h.read(TargetHeaterCoolerState)).toBe(TargetHeaterCoolerState.COOL);
    });

    it('follows changes made with the remote', () => {
      const h = createHarness();
      h.device.connect(climateState({ mode: ClimateMode.Heat }));
      h.device.report(climateState({ mode: ClimateMode.Cool, targetTemperature: 24 }));

      expect(h.shown(TargetHeaterCoolerState)).toBe(TargetHeaterCoolerState.COOL);
      expect(h.shown(Characteristic.CoolingThresholdTemperature)).toBe(24);
    });

    it('does not offer Auto', () => {
      const h = createHarness();
      h.device.connect();

      expect(h.characteristic(TargetHeaterCoolerState).props.validValues).toEqual([
        TargetHeaterCoolerState.HEAT,
        TargetHeaterCoolerState.COOL,
      ]);
    });

    it('uses the device range and step for both thresholds', () => {
      const h = createHarness();
      h.device.connect();

      for (const type of [Characteristic.CoolingThresholdTemperature, Characteristic.HeatingThresholdTemperature]) {
        expect(h.characteristic(type).props).toMatchObject({ minValue: 17, maxValue: 30, minStep: 0.5 });
      }
    });

    it('infers heating from the temperatures', async () => {
      const h = createHarness();
      h.device.connect(climateState({ currentTemperature: 20, targetTemperature: 21 }));

      expect(await h.read(CurrentHeaterCoolerState)).toBe(CurrentHeaterCoolerState.HEATING);
    });

    it('keeps characteristics cached by an earlier version until the device reports its traits', () => {
      // 0.1.14 cached a HeaterCooler with SwingMode but no traits. Removing SwingMode
      // at startup and re-adding it on connect would give it a new ID in HomeKit.
      let swing: Characteristic | undefined;
      const h = createHarness({
        cached: (accessory) => {
          swing = accessory.addService(Service.HeaterCooler, 'Mr. Cool').getCharacteristic(SwingMode);
        },
      });
      expect(h.characteristic(SwingMode)).toBe(swing);

      h.device.connect();
      expect(h.characteristic(SwingMode)).toBe(swing);
    });

    it('uses the traits cached from the last connection until the device connects', () => {
      const h = createHarness({ context: { traits: { ...traits, visualMaxTemperature: 28 } } });

      expect(h.characteristic(Characteristic.CoolingThresholdTemperature).props.maxValue).toBe(28);
    });
  });

  describe('No Response', () => {
    it('before the device has connected', async () => {
      const h = createHarness();

      await expect(h.read(Active)).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    });

    it('while disconnected, for reads and writes', async () => {
      const h = createHarness();
      h.device.connect();
      h.device.disconnect();

      await expect(h.read(Characteristic.CurrentTemperature)).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      await expect(h.write([Active, Active.INACTIVE])).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      expect(h.device.commands).toEqual([]);
    });

    it('recovers when the device reconnects', async () => {
      const h = createHarness();
      h.device.connect();
      h.device.disconnect();
      h.device.report(climateState({ mode: ClimateMode.Cool }));

      expect(await h.read(TargetHeaterCoolerState)).toBe(TargetHeaterCoolerState.COOL);
    });
  });

  describe('turning on', () => {
    it('Heat at 75°F from off, sent by iOS as one request', async () => {
      const h = createHarness();
      h.device.connect(climateState({ mode: ClimateMode.Off }));

      await h.write(
        [Active, Active.ACTIVE],
        [TargetHeaterCoolerState, TargetHeaterCoolerState.HEAT],
        [Characteristic.HeatingThresholdTemperature, fahrenheitToCelsius(75)],
      );
      await h.flush();

      expect(h.device.commands).toEqual([{ mode: ClimateMode.Heat, targetTemperature: 24 }]);
    });

    it('the same writes as separate requests, in the other order', async () => {
      const h = createHarness();
      h.device.connect(climateState({ mode: ClimateMode.Off }));

      await h.write([Characteristic.HeatingThresholdTemperature, fahrenheitToCelsius(75)]);
      await h.write([TargetHeaterCoolerState, TargetHeaterCoolerState.HEAT]);
      await h.write([Active, Active.ACTIVE]);
      await h.flush();

      expect(h.device.commands).toEqual([{ mode: ClimateMode.Heat, targetTemperature: 24 }]);
    });

    it('Active alone resumes the mode the AC was last on in', async () => {
      const h = createHarness();
      h.device.connect(climateState({ mode: ClimateMode.Dry }));
      h.device.report(climateState({ mode: ClimateMode.Off }));

      await h.write([Active, Active.ACTIVE]);
      await h.flush();

      expect(h.device.commands).toEqual([{ mode: ClimateMode.Dry }]);
    });

    it('migrates the mode saved by earlier versions', async () => {
      const h = createHarness({ context: { lastTargetMode: TargetHeaterCoolerState.HEAT } });
      h.device.connect(climateState({ mode: ClimateMode.Off }));

      await h.write([Active, Active.ACTIVE]);
      await h.flush();

      expect(h.device.commands).toEqual([{ mode: ClimateMode.Heat }]);
      expect(h.context).toMatchObject({ lastHeatCoolMode: ClimateMode.Heat });
      expect(h.context).not.toHaveProperty('lastTargetMode');
    });

    it('sends nothing when HomeKit re-sends values that already match', async () => {
      const h = createHarness();
      h.device.connect(climateState({ targetTemperature: 21 }));

      await h.write([Active, Active.ACTIVE], [Characteristic.HeatingThresholdTemperature, 21]);
      await h.flush();

      expect(h.device.commands).toEqual([]);
    });
  });

  describe('confirmation', () => {
    it('keeps showing a requested change while the AC confirms it', async () => {
      const h = createHarness();
      h.device.connect(climateState({ mode: ClimateMode.Heat }));

      await h.write([TargetHeaterCoolerState, TargetHeaterCoolerState.COOL]);
      expect(await h.read(TargetHeaterCoolerState)).toBe(TargetHeaterCoolerState.COOL); // before sending
      await h.flush();

      // A room-temperature update arrives before the AC has switched modes.
      h.device.report(climateState({ mode: ClimateMode.Heat, currentTemperature: 23 }));
      expect(h.shown(TargetHeaterCoolerState)).toBe(TargetHeaterCoolerState.COOL);

      h.device.apply(h.device.lastCommand()!);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.shown(TargetHeaterCoolerState)).toBe(TargetHeaterCoolerState.COOL);
      expect(h.log.info).not.toHaveBeenCalledWith(expect.stringContaining('did not apply'));
    });

    it('falls back to what the AC reports when it ignores a change', async () => {
      const h = createHarness();
      h.device.connect(climateState({ mode: ClimateMode.Heat, swingMode: ClimateSwingMode.Vertical }));

      await h.write([SwingMode, SwingMode.SWING_DISABLED]);
      await h.flush();
      expect(h.device.commands).toEqual([{ swingMode: ClimateSwingMode.Off }]);
      h.device.apply(h.device.lastCommand()!); // this AC ignores swing changes in Heat
      expect(h.shown(SwingMode)).toBe(SwingMode.SWING_DISABLED);

      await vi.advanceTimersByTimeAsync(8_100);
      expect(h.shown(SwingMode)).toBe(SwingMode.SWING_ENABLED);
      expect(h.log.info).toHaveBeenCalledWith(expect.stringContaining('did not apply swing=Off'));
    });

    it('shows the setpoint the AC settled on', async () => {
      const h = createHarness();
      h.device.connect(climateState({ mode: ClimateMode.Cool }));

      await h.write([Characteristic.CoolingThresholdTemperature, fahrenheitToCelsius(72)]);
      await h.flush();
      h.device.apply(h.device.lastCommand()!);

      expect(h.device.lastCommand()).toEqual({ targetTemperature: 22 });
      expect(h.shown(Characteristic.CoolingThresholdTemperature)).toBe(22);
      expect(h.shown(Characteristic.HeatingThresholdTemperature)).toBe(22);
    });
  });

  describe('fan and swing', () => {
    it('maps the fan slider onto Auto/Low/Medium/High', async () => {
      const h = createHarness();
      h.device.connect();
      expect(h.characteristic(Characteristic.RotationSpeed).props.minStep).toBeCloseTo(33.33, 1);

      await h.write([Characteristic.RotationSpeed, 100]);
      await h.flush();
      expect(h.device.lastCommand()).toEqual({ fanMode: ClimateFanMode.High });
    });

    it('turns swing on with the configured louvers', async () => {
      const h = createHarness({ config: { swing: 'horizontal' } });
      h.device.connect(climateState({ mode: ClimateMode.Cool, swingMode: ClimateSwingMode.Off }));

      await h.write([SwingMode, SwingMode.SWING_ENABLED]);
      await h.flush();
      expect(h.device.lastCommand()).toEqual({ swingMode: ClimateSwingMode.Horizontal });
    });
  });

  describe('extra switches', () => {
    it('adds Dry and Fan Only switches by default, and no preset switches', () => {
      const h = createHarness();
      h.device.connect();

      expect(h.switchService('dry')).toBeDefined();
      expect(h.switchService('fan-only')).toBeDefined();
      expect(h.switchService('boost')).toBeUndefined();
    });

    it('switches to Dry and shows it', async () => {
      const h = createHarness();
      h.device.connect(climateState({ mode: ClimateMode.Cool }));
      const dry = h.switchService('dry')!.getCharacteristic(Characteristic.On);

      await dry.handleSetRequest(true);
      await h.flush();
      expect(h.device.commands).toEqual([{ mode: ClimateMode.Dry }]);

      h.device.apply(h.device.lastCommand()!);
      expect(dry.value).toBe(true);
      expect(h.shown(TargetHeaterCoolerState)).toBe(TargetHeaterCoolerState.COOL);
    });

    it('turning Dry off returns to the last heat/cool mode', async () => {
      const h = createHarness();
      h.device.connect(climateState({ mode: ClimateMode.Heat }));
      h.device.report(climateState({ mode: ClimateMode.Dry }));

      await h.switchService('dry')!.getCharacteristic(Characteristic.On).handleSetRequest(false);
      await h.flush();
      expect(h.device.commands).toEqual([{ mode: ClimateMode.Heat }]);
    });

    it('removes switches that are turned off in the config', () => {
      const h = createHarness({ config: { dryModeSwitch: false, presetSwitches: true } });
      h.device.connect();

      expect(h.switchService('dry')).toBeUndefined();
      expect(h.switchService('boost')).toBeDefined();
      expect(h.switchService('sleep')).toBeDefined();
    });

    it('adds the outdoor temperature sensor when the device reports it', () => {
      const h = createHarness();
      h.device.connect();
      h.device.setEntityState('air_conditioner_outdoor_temperature', 4);

      const sensor = h.accessory.getServiceById(Service.TemperatureSensor, 'outdoor');
      expect(sensor?.getCharacteristic(Characteristic.CurrentTemperature).value).toBe(4);
    });

    it('skips the outdoor sensor when turned off in the config', () => {
      const h = createHarness({ config: { outdoorTemperature: false } });
      h.device.connect();
      h.device.setEntityState('air_conditioner_outdoor_temperature', 4);

      expect(h.accessory.getServiceById(Service.TemperatureSensor, 'outdoor')).toBeUndefined();
    });
  });
});
