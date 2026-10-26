import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import * as hap from '@homebridge/hap-nodejs';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';

const devices: Array<{ options: { host: string }; connect: ReturnType<typeof vi.fn> }> = [];

vi.mock('../src/device.js', async () => {
  const { EventEmitter } = await import('node:events');
  class AcDevice extends EventEmitter {
    available = false;
    climateState = null;
    entities = new Map();
    entityStates = new Map();
    connect = vi.fn();
    disconnect = vi.fn();
    constructor(readonly options: { host: string }) {
      super();
      devices.push(this as never);
    }
  }
  return { AcDevice };
});

const { SmartlightPlatform } = await import('../src/platform.js');

class FakePlatformAccessory {
  readonly context: Record<string, unknown> = {};
  private readonly hapAccessory: hap.Accessory;

  constructor(readonly displayName: string, readonly UUID: string) {
    this.hapAccessory = new hap.Accessory(displayName, UUID);
  }

  getService(type: typeof hap.Service) {
    return this.hapAccessory.getService(type as never);
  }

  addService(...args: unknown[]) {
    return (this.hapAccessory.addService as (...a: unknown[]) => hap.Service)(...args);
  }

  getServiceById(type: typeof hap.Service, subtype: string) {
    return this.hapAccessory.getServiceById(type as never, subtype);
  }

  removeService(service: hap.Service) {
    this.hapAccessory.removeService(service);
  }
}

function createPlatform(devicesConfig: Array<{ name: string; host: string }>) {
  devices.length = 0;
  const api = Object.assign(new EventEmitter(), {
    hap,
    platformAccessory: FakePlatformAccessory,
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
  });
  const log = Object.assign(vi.fn(), { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() });
  const platform = new SmartlightPlatform(log as never, { platform: PLATFORM_NAME, devices: devicesConfig } as never,
    api as never);
  return { api, log, platform };
}

const acUUID = hap.uuid.generate('air-conditioner-4ed907-climate');

describe('SmartlightPlatform', () => {
  it('keeps the accessory UUID earlier versions used, so HomeKit keeps the same accessory', () => {
    const { api, platform } = createPlatform([{ name: 'Mr. Cool', host: 'air-conditioner-4ed907' }]);
    const cached = new FakePlatformAccessory('Mr. Cool', acUUID);
    platform.configureAccessory(cached as never);
    api.emit('didFinishLaunching');

    expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(cached.getService(hap.Service.HeaterCooler)).toBeDefined();
    expect(devices[0].connect).toHaveBeenCalled();
  });

  it('removes a duplicate cached copy of the same accessory', () => {
    const { api, platform } = createPlatform([{ name: 'Mr. Cool', host: 'air-conditioner-4ed907' }]);
    const first = new FakePlatformAccessory('Mr. Cool', acUUID);
    const duplicate = new FakePlatformAccessory('Mr. Cool', acUUID);
    platform.configureAccessory(first as never);
    platform.configureAccessory(duplicate as never);
    api.emit('didFinishLaunching');

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, [duplicate]);
    expect(first.getService(hap.Service.HeaterCooler)).toBeDefined();
  });

  it('registers a new accessory even when Homebridge 2 beta throws on the second registration', () => {
    const { api } = createPlatform([{ name: 'Mr. Cool', host: 'ac.local' }]);
    api.registerPlatformAccessories.mockImplementation(() => {
      throw new Error('Tried to bridge Mr. Cool while it was already bridged');
    });
    api.emit('didFinishLaunching');

    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    expect(api.updatePlatformAccessories).toHaveBeenCalled(); // drops the duplicate it cached
    expect(devices[0].connect).toHaveBeenCalled();
  });

  it('removes cached accessories that are no longer configured', () => {
    const { api, platform } = createPlatform([]);
    const old = new FakePlatformAccessory('Old', hap.uuid.generate('old-host-climate'));
    platform.configureAccessory(old as never);
    api.emit('didFinishLaunching');

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, [old]);
  });

  it('skips devices without a host and duplicate hosts', () => {
    const { api, log } = createPlatform([
      { name: 'No host', host: '' },
      { name: 'A', host: 'ac.local' },
      { name: 'A again', host: 'ac.local' },
    ]);
    api.emit('didFinishLaunching');

    expect(devices.map((d) => d.options.host)).toEqual(['ac.local']);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('has no host'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('more than once'));
  });
});
