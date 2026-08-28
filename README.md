# ecoflow2mqtt

Interface between EcoFlow **STREAM Microinverter** / **PowerStream** micro-inverters and MQTT,
following the [mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) convention, with
Home Assistant discovery. Built on
[mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core).

**0.1.0 publishes the current PV power — both inputs and the total — and nothing else.** That is
deliberate: the protocol work is done ([RESEARCH.md](RESEARCH.md)), the remaining readings and the
settables are the next milestones ([ROADMAP.md](ROADMAP.md)). Values arrive every few seconds, the
way the EcoFlow app shows them, without the app having to be open.

## Topics

| Topic                                          | Payload                            | Meaning                        |
| ---------------------------------------------- | ---------------------------------- | ------------------------------ |
| `<name>/status/pv1_watts`                      | `{"val": 81.7, "ts": …, "lc": …}`  | PV input 1, W                  |
| `<name>/status/pv2_watts`                      | `{"val": 81.1, "ts": …, "lc": …}`  | PV input 2, W                  |
| `<name>/status/pv_watts`                       | `{"val": 162.8, "ts": …, "lc": …}` | total (input 1 + input 2), W   |
| `<name>/connected`                             | `0` \| `1` \| `2`                  | 2 = frames are arriving        |
| `<name>/info`                                  | JSON                               | version, region, masked serial |
| `<name>/maintenance/set/loglevel`, `…/restart` | `debug` …                          | provided by the core           |

`<name>` is the instance name, `ecoflow` by default (`--name`). Payloads are `{val, ts, lc}` JSON
unless the instance runs with `--no-json-payloads`. There are no `set/` topics yet — 0.1.0 is read
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
- The **serial number**, as shown in the app or on the device.
- The **region** the account was created in (`--region`, default `eu`). Accounts are region bound;
  a wrong region answers "account doesn't exist or incorrect password", which is also what an
  EcoFlow outage answers, so the adapter keeps retrying instead of giving up.

No developer account, no API keys: the adapter logs in the way the app does.

## Options

| Option              | Default            | Meaning                                                         |
| ------------------- | ------------------ | --------------------------------------------------------------- |
| `--email`           | required           | EcoFlow app account                                             |
| `--password`        | required           | its password                                                    |
| `--sn`              | required           | serial number of the inverter                                   |
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

Discovery is on by default: the inverter shows up as one device with three power sensors
(`device_class: power`, `state_class: measurement`), available while `<name>/connected` is `2`.
Turn it off with `--no-ha-discovery`. An energy (kWh) sensor for the energy dashboard needs the
device's energy counters — that is a later milestone.

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
- **Nothing is written to the inverter.** 0.1.0 only reads.

## Contributing a capture

If your firmware or your model sends different fields, run with `--capture <dir>` for a minute and
attach the file to an issue. The capture module removes the serial number and the account id
before writing, so it does not identify your device — the test suite checks that.

## License

MIT © Sebastian Raff
