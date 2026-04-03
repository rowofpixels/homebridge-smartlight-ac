# homebridge-smartlight-ac

Homebridge plugin for the [Smartlight SLWF-01pro](https://smartlight.me/smart-home-devices/wifi-devices/wifi-dongle-air-conditioners-midea-idea-electrolux-for-home-assistant) WiFi controller. Exposes Midea-family mini-split air conditioners (Mr. Cool, Pioneer, etc.) to Apple HomeKit as a HeaterCooler accessory.

Communicates with the device over the ESPHome native API — no cloud, no MQTT, fully local.

## Features

- Heat, cool, and auto modes
- Target temperature control
- Fan speed (auto / low / medium / high)
- Swing mode on/off
- Real-time state updates from the device
- Auto-reconnect on disconnect
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
| `host` | yes | | IP address or hostname of the SLWF-01pro |
| `port` | no | `6053` | ESPHome native API port |
| `password` | no | | API password, if configured on the device |
| `encryptionKey` | no | | API encryption key (base64), if configured |

## Development

```bash
npm install
npm run build
npm run watch   # rebuilds + restarts homebridge on file changes
```

The `watch` script uses an isolated config at `./test/hbConfig/config.json` so it won't affect a production Homebridge instance.

## Releasing

With [Claude Code](https://claude.ai/claude-code) installed:

```
/release patch    # or minor / major
```

This runs lint, build, and tests, bumps the version, pushes to GitHub, and creates a release with user-facing notes that appear in the Homebridge UI. The GitHub Release triggers the publish workflow, which pushes to npm.

## License

ISC
