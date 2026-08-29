# ecoflow2mqtt

Interface between EcoFlow **STREAM Microinverter** / **PowerStream** micro-inverters and MQTT,
following the [mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) convention, with
Home Assistant discovery. Built on
[mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core).

**0.2.0 publishes everything the inverter reports: PV power per input and in total, what goes into
the grid, the voltages, currents, frequency, feed-in limit and Wi-Fi signal.** It is still read
only — writing the feed-in limit is the next milestone ([ROADMAP.md](ROADMAP.md)); the protocol
research is in [RESEARCH.md](RESEARCH.md). Values arrive every few seconds, the way the EcoFlow app
shows them, without the app having to be open.

## Topics

All under `<name>/status/`, retained, payload `{"val": …, "ts": …, "lc": …}`:

| Item                                 | Example             | Meaning                                        |
| ------------------------------------ | ------------------- | ---------------------------------------------- |
| `pv1_watts`                          | `114.7`             | PV input 1, W                                  |
| `pv2_watts`                          | `112`               | PV input 2, W                                  |
| `pv_watts`                           | `226.7`             | both inputs together, W                        |
| `grid_watts`                         | `226`               | what actually goes into the grid, W            |
| `grid_status`                        | `feed_grid`         | `feed_grid`, `grid_in`, `offline` or `invalid` |
| `pv1_volts`, `pv1_amps`              | `33.71`, `3.64`     | PV input 1, V and A                            |
| `pv2_volts`, `pv2_amps`              | `33.38`, `3.58`     | PV input 2, V and A                            |
| `grid_volts`, `grid_amps`, `grid_hz` | `238`, `1.01`, `50` | the mains side                                 |
| `feed_limit_watts`                   | `600`               | feed-in limit the inverter runs with, W        |
| `feed_limit_max_watts`               | `600`               | highest limit it accepts, W                    |
| `wifi_rssi`                          | `-59`               | Wi-Fi signal of the inverter, dBm              |

Plus, next to `status/`:

| Topic                                          | Payload           | Meaning                        |
| ---------------------------------------------- | ----------------- | ------------------------------ |
| `<name>/connected`                             | `0` \| `1` \| `2` | 2 = frames are arriving        |
| `<name>/info`                                  | JSON              | version, region, masked serial |
| `<name>/maintenance/set/loglevel`, `…/restart` | `debug` …         | provided by the core           |

`<name>` is the instance name, `ecoflow` by default (`--name`). Payloads are `{val, ts, lc}` JSON
unless the instance runs with `--no-json-payloads`. There are no `set/` topics yet — 0.2.0 is read
only.

## Install

Needs Node.js >= 20.19.

```bash
npm install -g ecoflow2mqtt
ecoflow2mqtt --email you@example.com --password 'your-app-password' --sn BK01Z... -u mqtt://broker
```

As a systemd service (one instance per inverter, credentials in `/etc/ecoflow2mqtt/<name>.env`
with mode 600, state in `/var/lib/ecoflow2mqtt/<name>/`):

```bash
sudo ecoflow2mqtt --install --name balcony \
    --email you@example.com --password 'your-app-password' --sn BK01Z... -u mqtt://broker
sudo systemctl status ecoflow2mqtt@balcony
journalctl -fu ecoflow2mqtt@balcony
```

Every option can also be set as an environment variable (`ECOFLOW2MQTT_SN`, `ECOFLOW2MQTT_POLL`,
…); `MQTT_URL`, `MQTT_USERNAME` and `MQTT_PASSWORD` are used as a fallback, so several adapters can
share `/etc/mqtt-interfaces/broker.env`. Prefer the env file over the command line — a process list
is world readable.

### Docker

Multi-arch image (amd64, arm64, armv7):

```
docker run -d --name ecoflow2mqtt --restart unless-stopped -v ecoflow2mqtt:/data \
  -e ECOFLOW2MQTT_EMAIL=you@example.com -e ECOFLOW2MQTT_PASSWORD='your-app-password' \
  -e ECOFLOW2MQTT_SN=BK01Z... -e ECOFLOW2MQTT_MQTT_URL=mqtt://broker \
  ghcr.io/hobbyquaker/ecoflow2mqtt
```

The `/data` volume keeps the mqtt client id stable across restarts — without it EcoFlow's broker
sees a new client on every start.

## What you need

- The **EcoFlow app account** the inverter is bound to (a shared device does not work — bind it to
  this account in the app).
- The **serial number**, as shown in the app or on the device — or let `--discover` find it, below.
- The **region** the account was created in (`--region`, default `eu`). Accounts are region bound;
  a wrong region answers "account doesn't exist or incorrect password", which is also what an
  EcoFlow outage answers, so the adapter keeps retrying instead of giving up.

No developer account, no API keys: the adapter logs in the way the app does.

### Finding the serial number

```
ecoflow2mqtt --email you@example.com --password 'your-app-password' --discover
```

prints every device the account owns, with its serial, name and whether EcoFlow currently
considers it online:

```
BK01Z…  Balcony  (cloud)
```

`--discover-json` gives the same as JSON. `--sn auto` takes the serial when the account owns
exactly one device and refuses when it owns several, so nothing is guessed:

```
sudo ecoflow2mqtt --install -n balcony --email … --password … --sn auto
```

resolves it **once** and writes it into the instance's env file, rather than making every service
start depend on EcoFlow's API being reachable.

Note this is not a network scan, and there is nothing on your LAN to scan for: the inverter only
ever talks to EcoFlow (see [How it works](#how-it-works-and-what-that-means-for-you)). `--discover`
is a login, so unlike other adapters in the fleet it needs `--email` and `--password` — the two
options it cannot do without. An `online: false` device is still listed: EcoFlow's flag lags by up
to ~15 minutes, and an inverter that is dark at night is still the one you want to configure.

## Options

| Option              | Default            | Meaning                                                         |
| ------------------- | ------------------ | --------------------------------------------------------------- |
| `--email`           | required           | EcoFlow app account                                             |
| `--password`        | required           | its password                                                    |
| `--sn`              | required           | serial number of the inverter, or `auto` (see `--discover`)     |
| `--region`          | `eu`               | `eu`, `us`, `global`, `americas`, `cn`                          |
| `--api-host`        | from region        | override the API host                                           |
| `--mqtt-host`       | from login         | override the EcoFlow broker (it occasionally names a wrong one) |
| `--poll`            | `60`               | seconds between full-frame refreshes; `0` = passive             |
| `--stream-interval` | `0`                | seconds between "activate stream" frames; try `20` if it stalls |
| `--timeout`         | `300`              | seconds without a frame before `connected` drops to `1`         |
| `--capture`         | off                | directory for raw frames (serial and account id removed)        |
| `--state-dir`       | `$STATE_DIRECTORY` | where the MQTT client id is kept                                |

Plus the shared options of every adapter (`--name`, `-u/--mqtt-url`, `--json-payloads`,
`--ha-discovery`, `--verbosity`, `--install`, `--config-schema`, …): `ecoflow2mqtt --help`.

## Home Assistant

Discovery is on by default: the inverter shows up as one device with fifteen sensors, available
while `<name>/connected` is `2`. The four power values and the grid status are the primary
entities; voltages, currents, frequency, the limits and the Wi-Fi signal are filed under
diagnostics. Readings carry `state_class: measurement`, so HA keeps long-term statistics for them.
Turn discovery off with `--no-ha-discovery`.

For the energy dashboard you need kWh, and this firmware sends no energy counters — add a
[Riemann sum helper](https://www.home-assistant.io/integrations/integration/) on `pv_watts` (or on
`grid_watts` for what you actually feed in).

## How it works, and what that means for you

The adapter logs into EcoFlow's cloud with your app account, asks for the MQTT credentials the app
uses, and subscribes to the inverter's telemetry topic. Frames are protobuf, obfuscated with a
one-byte XOR; the decoder and the field numbers are in `lib/proto/`.

- **This is the unofficial API the app uses**, not EcoFlow's developer platform. It has been stable
  since 2023 and is what most EcoFlow integrations use, but EcoFlow can change it at any time.
  ecoflow2mqtt keeps the protocol in data files so a change is a small fix, not a rewrite.
- **Values update every 2–6 seconds** as long as the adapter is subscribed — measured over 20
  minutes with the app closed. Reports of the stream throttling when nobody is watching did not
  reproduce on this path; if yours does stall, set `--stream-interval 20` and please open an issue.
- **Your credentials stay on your machine**; they go to EcoFlow's login endpoint only.
- **Nothing is written to the inverter.** 0.2.0 only reads.

## Contributing a capture

If your firmware or your model sends different fields, run with `--capture <dir>` for a minute and
attach the file to an issue. The capture module removes the serial number and the account id
before writing, so it does not identify your device — the test suite checks that.

## License

MIT © Sebastian Raff
