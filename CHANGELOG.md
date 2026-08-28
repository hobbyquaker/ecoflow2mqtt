# Changelog

## 0.1.1

### Added

- Docker images on `ghcr.io/hobbyquaker/ecoflow2mqtt`, built for amd64, arm64 and armv7 by the
  release workflow on every tag (`x.y.z`, `x.y`, `latest`); `docker run` example in the README.

### Fixed

- The image creates `/data` owned by `node`: on a fresh volume docker created the mount point
  root-owned, so the container could not persist the mqtt client id.

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), the project uses
[semantic versioning](https://semver.org/).

## 0.1.0 - 2026-08-28

First working release: the current PV power on MQTT.

### Added

- App-account cloud path: login, certification, MQTT over TLS with the client id EcoFlow's broker
  expects, persisted across restarts.
- Protobuf decoding of `DisplayPropertyUpload` (`cmd_func 254 / cmd_id 21`) including the XOR
  obfuscation; `.proto` files vendored as data, unknown command pairs logged once instead of
  failing.
- Items `pv1_watts`, `pv2_watts` and `pv_watts` (computed sum — the STREAM Microinverter firmware
  does not send one), published as retained `{val, ts, lc}`.
- Home Assistant discovery: one device, three power sensors.
- `--poll` full-frame refresh, `--stream-interval` (off by default), `--timeout` for the
  `connected` state, `--capture` for frame captures with the serial number and account id removed.
- systemd installer (`--install`), 82 unit tests including decoding tests against real captures.

### Notes

- Read only: no `set/` topics yet.
- Verified against a STREAM Microinverter (BK01, EU, `product_id 17409`) on 2026-08-28.

## 0.0.1 - 2026-08-27

- Placeholder release to reserve the package name.
