import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AcDevice, type EsphomeClient } from '../src/device.js';
import { ClimateMode } from '../src/esphome.js';
import { climateState, fixture, traits } from './helpers.js';

/** Behaves like @2colors/esphome-native-api's entities: unusable once destroyed. */
class FakeEntity extends EventEmitter {
  readonly commands: object[] = [];
  private destroyed = false;

  constructor(readonly type: string, readonly config: { objectId: string; key: number; name: string }) {
    super();
  }

  command(data: object): void {
    if (this.destroyed) {
      throw new Error('connection is not attached');
    }
    this.commands.push(data);
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

class FakeClient extends EventEmitter implements EsphomeClient {
  connect = vi.fn();
  disconnect = vi.fn();
  entities: FakeEntity[] = [];

  /** What the library does on (re)connect: drop old entities, list new ones, send states. */
  simulateConnect(state = climateState()): FakeEntity {
    for (const entity of this.entities) {
      entity.destroy();
    }
    this.emit('connected');
    const climate = new FakeEntity('Climate', traits);
    const sensors = fixture.entities
      .filter((e) => e.type === 'Sensor')
      .map((e) => new FakeEntity(e.type, e.config as never));
    this.entities = [climate, ...sensors];
    for (const entity of this.entities) {
      this.emit('newEntity', entity);
    }
    this.emit('initialized');
    climate.emit('state', state);
    return climate;
  }

  simulateDisconnect(): void {
    this.emit('disconnected');
  }
}

function createDevice() {
  const client = new FakeClient();
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const device = new AcDevice({ name: 'Test', host: 'ac.local', clientInfo: 'test', log }, () => client);
  return { client, device, log };
}

describe('AcDevice', () => {
  it('becomes available once the climate entity reports state', () => {
    const { client, device } = createDevice();
    const availability = vi.fn();
    device.on('availability', availability);

    client.simulateConnect(climateState({ mode: ClimateMode.Cool }));

    expect(device.available).toBe(true);
    expect(availability).toHaveBeenCalledWith(true);
    expect(device.climateConfig).toEqual(traits);
    expect(device.climateState?.mode).toBe(ClimateMode.Cool);
  });

  it('ignores the placeholder state the controller sends right after booting', () => {
    const { client, device } = createDevice();
    // Observed after a reboot: mode Off, NaN temperatures, until the AC answers.
    client.simulateConnect(climateState({ mode: ClimateMode.Off, currentTemperature: NaN, targetTemperature: NaN }));

    expect(device.available).toBe(false);
    expect(device.climateState).toBeNull();
  });

  it('keeps working after a reconnect replaces the entities', () => {
    const { client, device } = createDevice();
    const states = vi.fn();
    device.on('climateState', states);

    const first = client.simulateConnect();
    client.simulateDisconnect();
    expect(device.available).toBe(false);

    const second = client.simulateConnect(climateState({ targetTemperature: 23 }));
    expect(device.available).toBe(true);
    expect(device.climateState?.targetTemperature).toBe(23);

    // Commands go to the new entity; the old one would throw.
    expect(device.sendClimateCommand({ mode: ClimateMode.Off })).toBe(true);
    expect(second.commands).toEqual([{ mode: ClimateMode.Off }]);
    expect(first.commands).toEqual([]);

    // State from the new entity keeps flowing.
    second.emit('state', climateState({ targetTemperature: 24 }));
    expect(states).toHaveBeenLastCalledWith(expect.objectContaining({ targetTemperature: 24 }));
  });

  it('refuses commands while disconnected instead of throwing', () => {
    const { client, device, log } = createDevice();
    client.simulateConnect();
    client.simulateDisconnect();

    expect(device.sendClimateCommand({ mode: ClimateMode.Off })).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('command not sent'));
  });

  it('returns false if the library throws while sending', () => {
    const { client, device } = createDevice();
    const climate = client.simulateConnect();
    climate.command = () => {
      throw new Error('Not authorized');
    };

    expect(device.sendClimateCommand({ mode: ClimateMode.Off })).toBe(false);
  });

  it('tracks sensor states, and forgets missing ones', () => {
    const { client, device } = createDevice();
    client.simulateConnect();
    const outdoor = client.entities.find((e) => e.config.objectId.includes('outdoor'))!;
    const changes = vi.fn();
    device.on('entityState', changes);

    outdoor.emit('state', { key: 1, state: 4, missingState: false });
    expect(device.entityStates.get(outdoor.config.objectId)).toBe(4);
    expect(changes).toHaveBeenCalledWith(outdoor.config.objectId, 4);

    outdoor.emit('state', { key: 1, state: 0, missingState: true });
    expect(device.entityStates.has(outdoor.config.objectId)).toBe(false);
  });

  it('does not warn about the disconnect it was asked for', () => {
    const { client, device, log } = createDevice();
    client.simulateConnect();
    device.disconnect();
    client.simulateDisconnect();

    expect(client.disconnect).toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
