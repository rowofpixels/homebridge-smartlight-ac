# homebridge-smartlight-ac

Homebridge plugin for the [Smartlight SLWF-01pro](https://smartlight.me/smart-home-devices/wifi-devices/wifi-dongle-air-conditioners-midea-idea-electrolux-for-home-assistant) WiFi controller. Exposes Midea-family mini-split air conditioners (Mr. Cool, Pioneer, etc.) to Apple HomeKit as a HeaterCooler accessory.

Communicates with the device over the ESPHome native API — no cloud, no MQTT, fully local.

## Features

- Heat and cool modes, with the mode always read back from the AC (changes made with the remote show up in Home)
- Target temperature, in °C or °F — whole-degree °F choices land exactly on the AC
- Fan speed (auto / low / medium / high) and swing
- Optional switches for Dry and Fan-only modes, and for the Boost and Sleep presets
- Outdoor temperature sensor
- Shows "No Response" when the controller is unreachable, and recovers by itself when it reconnects
- Compatible with Homebridge v1.8+ and v2

## Installation

### From npm (recommended)

Search for `homebridge-smartlight-ac` in the Homebridge UI, or:

```bash
npm install -g homebridge-smartlight-ac
```

### From GitHub

```bash
npm install -g git+https://github.com/rowofpixels/homebridge-smartlight-ac.git
```

## Configuration

Add the platform to your Homebridge `config.json`:

```json
{
    "platforms": [
        {
            "name": "SmartlightAC",
            "platform": "SmartlightAC",
            "devices": [
                {
                    "name": "Mr. Cool",
                    "host": "air-conditioner-4ed907",
                    "port": 6053
                }
            ]
        }
    ]
}
```

Or configure via the Homebridge UI settings page.

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | yes | | Display name for the accessory |
| `host` | yes | | IP address or hostname of the SLWF-01pro. Changing it later makes HomeKit see a new accessory. |
| `port` | no | `6053` | ESPHome native API port |
| `password` | no | | API password, if configured on the device |
| `encryptionKey` | no | | API encryption key (base64), if configured |
| `swing` | no | `vertical` | Louvers to move when swing is on: `vertical`, `horizontal`, or `both` |
| `dryModeSwitch` | no | `true` | Show a switch for Dry mode |
| `fanOnlySwitch` | no | `true` | Show a switch for Fan-only mode |
| `presetSwitches` | no | `false` | Show switches for the Boost and Sleep presets |
| `outdoorTemperature` | no | `true` | Show the outdoor temperature as a sensor |

Set `"debug": true` on the platform to log device state, every HomeKit change, and each command sent to the AC.

## How the AC maps to HomeKit

- **No Auto mode.** Midea's Auto keeps one setpoint, while HomeKit's Auto is a heat-to/cool-to range, so the plugin only offers Heat and Cool. If the AC is put in Auto with the remote, Home shows the last heat/cool mode.
- **One setpoint.** The AC has a single target temperature shared by every mode; both HomeKit thresholds show it.
- **Fan speed 0% means Auto**; Low, Medium and High are 33%, 67% and 100%.
- **Dry and Fan-only** are switches. Turning one off returns the AC to its last heat or cool mode.
- **Heating/cooling status** is inferred from the room and target temperatures, because the controller doesn't report whether the compressor is running.
- **Changes are confirmed.** Home shows a change right away; if the AC hasn't applied it within 8 seconds, Home goes back to what the AC reports and the log says what was ignored.

Behavior observed on an SLWF-01pro (firmware 2.1) with a Mr. Cool unit; other units may differ:

- Swing can't be changed while in Heat mode; the AC keeps the swing setting from the last other mode.
- The controller advertises "silent" and "turbo" fan modes, Eco, and freeze protection; the AC ignored or remapped these, so they aren't exposed. (Eco works only in Cool and forces 24 °C.)

## Development

```bash
npm install
npm test          # unit tests (no device needed)
npm run typecheck
npm run lint
```

### Talking to the AC directly

`npm run ac` uses the same connection code as the plugin, without Homebridge. It finds the device from `--host`, `$AC_HOST`, or the first device in `test/hbConfig/config.json`.

```bash
npm run ac -- info                          # device info, supported modes, current state, sensors
npm run ac -- watch --logs                  # stream state changes and the controller's own debug log
npm run ac -- send mode=cool temp=72F       # send a command and report whether the AC confirmed it
npm run ac -- repl                          # interactive: `mode heat`, `fan low`, `swing off`, ...
npm run ac -- record test/fixtures/my-ac.json   # save traits and states as a test fixture
```

### Running Homebridge locally

```bash
npm run watch
```

This rebuilds and restarts a local Homebridge on every change, using the isolated config in `test/hbConfig/` and loading the plugin straight from this checkout. Pair the "Smartlight Dev Bridge" in the Home app to try changes without touching your real Homebridge.

The dev bridge also runs in insecure mode (`-I`), so HomeKit reads and writes can be scripted with the bridge PIN as the `Authorization` header:

```bash
curl -H "Authorization: 031-45-154" http://localhost:51826/accessories
curl -X PUT -H "Authorization: 031-45-154" http://localhost:51826/characteristics \
  -d '{"characteristics":[{"aid":2,"iid":10,"value":1}]}'
```

## Releasing

With [Claude Code](https://claude.ai/claude-code) installed:

```
/release patch    # or minor / major
```

This runs lint, build, and tests, bumps the version, pushes to GitHub, and creates a release with user-facing notes that appear in the Homebridge UI. The GitHub Release triggers the publish workflow, which pushes to npm.

## License

ISC
