/**
 * Talk to an SLWF-01pro (or any ESPHome climate device) directly, without Homebridge.
 *
 *   npm run ac -- info                               device info, traits, entities, current state
 *   npm run ac -- watch [--logs]                     stream state changes (and the device's own logs)
 *   npm run ac -- send mode=cool temp=72F fan=low    send one command and wait for the device to confirm it
 *   npm run ac -- repl                               interactive: `mode heat`, `temp 21.5`, `swing off`, ...
 *   npm run ac -- record test/fixtures/x.json        save traits and observed states as a test fixture
 *
 * Options: --host, --port, --logs, --timeout <s> (send), --settle <s> (send), --seconds <s> (watch, record).
 * The device defaults to $AC_HOST, then the first device in test/hbConfig/config.json.
 *
 * Command fields: mode=off|heat_cool|cool|heat|fan_only|dry  temp=<°C>|<n>F
 *   fan=auto|low|medium|high|<custom>  swing=off|vertical|horizontal|both  preset=none|eco|boost|sleep|<custom>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { AcDevice, type DeviceLog } from '../src/device.js';
import { describeCommand, describeState, roundToStep, unconfirmedFields } from '../src/climate.js';
import {
  ClimateFanMode,
  ClimateMode,
  ClimatePreset,
  ClimateSwingMode,
  LogLevel,
  enumName,
  type ClimateCommand,
  type ClimateConfig,
  type ClimateState,
} from '../src/esphome.js';

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: 'string' },
    port: { type: 'string' },
    logs: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '15' },
    settle: { type: 'string', default: '3' },
    seconds: { type: 'string' },
  },
});

const startedAt = Date.now();
const elapsed = () => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`.padStart(7);
const print = (message: string) => console.log(`${elapsed()} ${message}`);

const log: DeviceLog = {
  debug: () => {},
  info: (m) => print(m),
  warn: (m) => print(`WARN ${m}`),
  error: (m) => print(`ERROR ${m}`),
};

function deviceTarget(): { host: string; port?: number; password?: string; encryptionKey?: string } {
  if (flags.host) {
    return { host: flags.host, port: flags.port ? Number(flags.port) : undefined };
  }
  if (process.env.AC_HOST) {
    return { host: process.env.AC_HOST };
  }
  const configPath = new URL('../test/hbConfig/config.json', import.meta.url);
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const platform = config.platforms?.find((p: { platform: string }) => p.platform === 'SmartlightAC');
    const device = platform?.devices?.[0];
    if (device?.host) {
      return device;
    }
  }
  throw new Error('No device: pass --host, set AC_HOST, or add a device to test/hbConfig/config.json');
}

// ---- Command parsing ----

const normalize = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');

function lookupEnum(enumObject: Record<string, number>, input: string): number | undefined {
  const key = Object.keys(enumObject).find((k) => normalize(k) === normalize(input));
  return key === undefined ? undefined : enumObject[key];
}

function lookupCustom(list: string[], input: string): string | undefined {
  return list.find((item) => normalize(item) === normalize(input));
}

function parseTemperature(input: string): number {
  const match = /^(-?\d+(?:\.\d+)?)\s*([cf])?$/i.exec(input);
  if (!match) {
    throw new Error(`Bad temperature "${input}" (use e.g. 21.5 or 72F)`);
  }
  const value = Number(match[1]);
  return match[2]?.toLowerCase() === 'f' ? (value - 32) * 5 / 9 : value;
}

function parseCommand(tokens: string[], traits: ClimateConfig): ClimateCommand {
  // Accept both `mode=cool temp=22` and `mode cool temp 22`.
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.includes('=')) {
      const [key, ...rest] = token.split('=');
      pairs.push([key, rest.join('=')]);
    } else if (i + 1 < tokens.length) {
      pairs.push([token, tokens[++i]]);
    } else {
      throw new Error(`Missing value for "${token}"`);
    }
  }

  const command: ClimateCommand = {};
  for (const [key, value] of pairs) {
    switch (normalize(key)) {
      case 'mode': {
        const mode = normalize(value) === 'auto' ? ClimateMode.HeatCool : lookupEnum(ClimateMode, value);
        if (mode === undefined) {
          throw new Error(`Unknown mode "${value}"`);
        }
        command.mode = mode;
        break;
      }
      case 'temp':
      case 'target':
      case 'temperature':
        command.targetTemperature = parseTemperature(value);
        break;
      case 'fan': {
        const custom = lookupCustom(traits.supportedCustomFanModesList ?? [], value);
        const standard = lookupEnum(ClimateFanMode, value);
        if (custom !== undefined) {
          command.customFanMode = custom;
        } else if (standard !== undefined) {
          command.fanMode = standard;
        } else {
          throw new Error(`Unknown fan mode "${value}"`);
        }
        break;
      }
      case 'swing': {
        const swing = lookupEnum(ClimateSwingMode, value);
        if (swing === undefined) {
          throw new Error(`Unknown swing mode "${value}"`);
        }
        command.swingMode = swing;
        break;
      }
      case 'preset': {
        const custom = lookupCustom(traits.supportedCustomPresetsList ?? [], value);
        const standard = lookupEnum(ClimatePreset, value);
        if (custom !== undefined) {
          command.customPreset = custom;
        } else if (standard !== undefined) {
          command.preset = standard;
        } else {
          throw new Error(`Unknown preset "${value}"`);
        }
        break;
      }
      default:
        throw new Error(`Unknown field "${key}" (use mode, temp, fan, swing, preset)`);
    }
  }
  if (Object.keys(command).length === 0) {
    throw new Error('Empty command');
  }
  return command;
}

// ---- Device helpers ----

function connect(deviceLogLevel?: number): AcDevice {
  const target = deviceTarget();
  const device = new AcDevice({
    name: target.host,
    ...target,
    clientInfo: 'homebridge-smartlight-ac CLI',
    deviceLogLevel,
    log,
  });
  device.on('deviceLog', (line: string) => print(`  device| ${line}`));
  device.connect();
  return device;
}

function waitForAvailable(device: AcDevice, timeoutSeconds = 30): Promise<void> {
  if (device.available) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No climate state after ${timeoutSeconds}s`)), timeoutSeconds * 1000);
    device.once('availability', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describeTraits(traits: ClimateConfig): string[] {
  const names = (enumObject: Record<string, number>, values: number[] = []) =>
    values.map((v) => enumName(enumObject, v)).join(', ');
  return [
    `modes:         ${names(ClimateMode, traits.supportedModesList)}`,
    `fan modes:     ${names(ClimateFanMode, traits.supportedFanModesList)}` +
      (traits.supportedCustomFanModesList?.length ? ` + custom: ${traits.supportedCustomFanModesList.join(', ')}` : ''),
    `swing modes:   ${names(ClimateSwingMode, traits.supportedSwingModesList)}`,
    `presets:       ${names(ClimatePreset, traits.supportedPresetsList)}` +
      (traits.supportedCustomPresetsList?.length ? ` + custom: ${traits.supportedCustomPresetsList.join(', ')}` : ''),
    `temperature:   ${traits.visualMinTemperature}–${traits.visualMaxTemperature}°C, ` +
      `step ${traits.visualTargetTemperatureStep}`,
    `reports:       current temperature=${traits.supportsCurrentTemperature}, action=${traits.supportsAction}`,
  ];
}

/** Send a command and report when (or whether) the device's state reflects it. */
async function sendAndConfirm(device: AcDevice, command: ClimateCommand, timeoutSeconds: number): Promise<boolean> {
  // Round like the plugin does, so we exercise the values it would send.
  if (command.targetTemperature !== undefined) {
    command.targetTemperature = roundToStep(command.targetTemperature, device.climateConfig!.visualTargetTemperatureStep);
  }
  const before = device.climateState!;
  const alreadySatisfied = unconfirmedFields(command, before).length === 0;
  print(`SEND ${describeCommand(command)}${alreadySatisfied ? ' (already in that state)' : ''}`);
  const sentAt = Date.now();
  if (!device.sendClimateCommand(command)) {
    return false;
  }
  return new Promise((resolve) => {
    const onState = (state: ClimateState) => {
      const pending = unconfirmedFields(command, state);
      if (pending.length === 0 && !alreadySatisfied) {
        finish(true, `CONFIRMED after ${((Date.now() - sentAt) / 1000).toFixed(1)}s: ${describeState(state)}`);
      }
    };
    const timer = setTimeout(() => {
      const state = device.climateState!;
      const pending = unconfirmedFields(command, state);
      if (pending.length === 0) {
        finish(true, `UNCHANGED (as expected): ${describeState(state)}`);
      } else {
        finish(false, `NOT CONFIRMED after ${timeoutSeconds}s (${pending.join(', ')}): ${describeState(state)}`);
      }
    }, timeoutSeconds * 1000);
    const finish = (ok: boolean, message: string) => {
      clearTimeout(timer);
      device.off('climateState', onState);
      print(message);
      resolve(ok);
    };
    device.on('climateState', onState);
  });
}

// ---- Commands ----

async function info(): Promise<void> {
  const device = connect();
  await waitForAvailable(device);
  await sleep(2000); // let sensor states arrive
  const di = device.deviceInfo;
  if (di) {
    console.log(`\n${di.friendlyName || di.name}: ${di.projectName} ${di.projectVersion}, ESPHome ${di.esphomeVersion}, ` +
      `${di.model}, MAC ${di.macAddress}`);
  }
  console.log(`\nClimate "${device.climateConfig!.name}":`);
  for (const line of describeTraits(device.climateConfig!)) {
    console.log(`  ${line}`);
  }
  console.log(`  state:         ${describeState(device.climateState!)}`);
  console.log('\nOther entities:');
  for (const [objectId, { type, config }] of device.entities) {
    const value = device.entityStates.get(objectId);
    const unit = config.unitOfMeasurement ? ` ${config.unitOfMeasurement}` : '';
    console.log(`  ${type.padEnd(12)} ${objectId.padEnd(40)} ${value === undefined ? '' : `${value}${unit}`}`);
  }
  device.disconnect();
}

async function watch(): Promise<void> {
  const device = connect(flags.logs ? LogLevel.Debug : undefined);
  let lastState = '';
  device.on('climateState', (state: ClimateState) => {
    const description = describeState(state);
    if (description !== lastState) {
      print(`STATE ${description}`);
      lastState = description;
    }
  });
  device.on('entityState', (objectId: string, value: unknown) => print(`ENTITY ${objectId} = ${value}`));
  device.on('availability', (available: boolean) => print(available ? 'available' : 'UNAVAILABLE'));
  if (flags.seconds) {
    await sleep(Number(flags.seconds) * 1000);
    device.disconnect();
  } else {
    await new Promise(() => {}); // until Ctrl-C
  }
}

async function send(tokens: string[]): Promise<void> {
  const device = connect(flags.logs ? LogLevel.Debug : undefined);
  await waitForAvailable(device);
  const command = parseCommand(tokens, device.climateConfig!);
  print(`BEFORE ${describeState(device.climateState!)}`);
  const ok = await sendAndConfirm(device, command, Number(flags.timeout));

  // Keep watching briefly in case the device changes its mind.
  const settleSeconds = Number(flags.settle);
  if (settleSeconds > 0) {
    let last = describeState(device.climateState!);
    const onState = (state: ClimateState) => {
      const description = describeState(state);
      if (description !== last) {
        print(`STATE ${description}`);
        last = description;
      }
    };
    device.on('climateState', onState);
    await sleep(settleSeconds * 1000);
    device.off('climateState', onState);
  }
  device.disconnect();
  process.exitCode = ok ? 0 : 1;
}

async function repl(): Promise<void> {
  const device = connect(flags.logs ? LogLevel.Debug : undefined);
  await waitForAvailable(device);
  print(`STATE ${describeState(device.climateState!)}`);
  let last = describeState(device.climateState!);
  device.on('climateState', (state: ClimateState) => {
    const description = describeState(state);
    if (description !== last) {
      print(`STATE ${description}`);
      last = description;
    }
  });
  device.on('availability', (available: boolean) => print(available ? 'available' : 'UNAVAILABLE'));

  console.log('Type a command (e.g. `mode cool temp 72F`), or: state, traits, help, quit');
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'ac> ' });
  rl.prompt();
  for await (const line of rl) {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    try {
      if (tokens.length === 0) {
        // nothing
      } else if (tokens[0] === 'quit' || tokens[0] === 'exit') {
        break;
      } else if (tokens[0] === 'state') {
        print(describeState(device.climateState!));
      } else if (tokens[0] === 'traits') {
        describeTraits(device.climateConfig!).forEach((l) => console.log(`  ${l}`));
      } else if (tokens[0] === 'help') {
        console.log('mode off|heat_cool|cool|heat|fan_only|dry   temp 21.5|72F   fan auto|low|medium|high|silent|turbo');
        console.log('swing off|vertical|horizontal|both   preset none|eco|boost|sleep|freeze_protection');
      } else {
        await sendAndConfirm(device, parseCommand(tokens, device.climateConfig!), Number(flags.timeout));
      }
    } catch (error) {
      console.log(`  ${(error as Error).message}`);
    }
    rl.prompt();
  }
  rl.close();
  device.disconnect();
}

async function record(path: string | undefined): Promise<void> {
  if (!path) {
    throw new Error('Usage: npm run ac -- record <fixture.json> [--seconds N]');
  }
  const device = connect();
  await waitForAvailable(device);
  const climateStates: ClimateState[] = [device.climateState!];
  device.on('climateState', (state: ClimateState) => climateStates.push(state));
  await sleep(Number(flags.seconds ?? 10) * 1000);

  // Leave out identifying details; fixtures are committed.
  const di = device.deviceInfo;
  const fixture = {
    recordedAt: new Date().toISOString(),
    deviceInfo: di && {
      esphomeVersion: di.esphomeVersion,
      model: di.model,
      projectName: di.projectName,
      projectVersion: di.projectVersion,
    },
    climateConfig: device.climateConfig,
    climateStates,
    entities: [...device.entities].map(([objectId, { type, config }]) => ({
      type,
      config,
      state: device.entityStates.get(objectId),
    })),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n');
  print(`Wrote ${climateStates.length} climate states and ${fixture.entities.length} entities to ${path}`);
  device.disconnect();
}

const [command, ...rest] = positionals;
const commands: Record<string, () => Promise<void>> = {
  info: () => info(),
  watch: () => watch(),
  send: () => send(rest),
  repl: () => repl(),
  record: () => record(rest[0]),
};

if (!command || !commands[command]) {
  console.log('Usage: npm run ac -- <info|watch|send|repl|record> [args] [--host H] [--logs]');
  process.exit(command ? 1 : 0);
}

commands[command]().then(
  () => setTimeout(() => process.exit(), 300),
  (error) => {
    console.error(`${elapsed()} ${(error as Error).message}`);
    process.exit(1);
  },
);
