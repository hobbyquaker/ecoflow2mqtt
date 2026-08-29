# Roadmap & implementation spec — ecoflow2mqtt

MQTT interface for the **EcoFlow STREAM Microinverter** (SN prefix `BK01`/`BK02`/`N011`; later also
the older PowerStream `HW51`), following the
[mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) architecture and the `xyz2mqtt`
fleet conventions. Built on
[mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core) (config, MQTT,
`{val, ts, lc}` payloads, `info` / `maintenance` topics, HA discovery publishing, installer,
logging); this adapter is left with the EcoFlow protocol (app-account login, cloud MQTT, protobuf
decoding, keep-alive) and the item table. The protocol research lives in [RESEARCH.md](RESEARCH.md);
section references like "R §4.5" point there.

One instance = **one inverter** (`--sn`), addressed as `<name>/status/<item>`. A multi-device
"bridge" layout is backlog (§7).

Fleet-wide decisions D-1 … D-13 live in the mqtt-interfaces master roadmap, the core's are C-n.
This file uses **E-n** for ecoflow2mqtt decisions and **OQ-En** for its open questions.
Status 2026-08-28: 0.0.1 placeholder published (name reserved), research done, no adapter code yet.

Contents: 1 goal · 2 what 0.1.0 does · 3 implementation spec · 4 decisions · 5 milestones ·
6 verify on the real device first · 7 backlog · 8 open questions

---

## 1. Goal

**The first and only goal of 0.1.0: the current PV power on MQTT. Nothing else.**

The inverter has two PV inputs. Three retained topics, updated at the app's cadence (~2–6 s):

| topic                     | meaning                    | unit | source (R §4.5)                                                                                  |
| ------------------------- | -------------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `<name>/status/pv1_watts` | PV input 1 power           | W    | `DisplayPropertyUpload.pow_get_pv` (field 361)                                                   |
| `<name>/status/pv2_watts` | PV input 2 power           | W    | `DisplayPropertyUpload.pow_get_pv2` (field 70)                                                   |
| `<name>/status/pv_watts`  | total PV power (pv1 + pv2) | W    | computed pv1 + pv2 — this firmware never sends `pow_get_pv_sum` (517), verified 2026-08-28 (E-4) |

Plus what the core gives for free: `<name>/connected` (`0`/`1`/`2`), `<name>/info`,
`maintenance/*`, and Home Assistant discovery for the three sensors (`device_class: power`,
`state_class: measurement`, `unit: W`).

Explicit **non-goals for 0.1.0** (all later milestones, §5): no `set/` topics, no grid / voltage /
current / frequency / temperature / RSSI items, no official Developer API, no PowerStream (`HW51`),
no BLE, no local broker, no multi-device.

---

## 2. What 0.1.0 does (the whole mechanism)

The path is **B — app-account MQTT with protobuf** (R §0, §4): the only cloud path that reliably
covers the STREAM Micro. Sequence:

1. `POST <api-host>/auth/login` with email + base64(password) → JWT + `userId` (R §4.1).
2. `GET <api-host>/iot-auth/app/certification?userId=…` → MQTT host, `certificateAccount`,
   `certificatePassword` (R §4.1).
3. Connect `mqtts://<host>:8883`, username/password = certificate account/password,
   **clientId `ANDROID_<UUID>_<userId>`** (R §4.2; UUID persisted, E-6).
4. Subscribe `/app/device/property/<SN>` (R §4.3).
5. Publish a protobuf _get_ (`src 32 → dest 32`, empty) to `/app/<userId>/<SN>/thing/property/get`
   every `--poll` s (default 60). Verified 2026-08-28 (E-9): the subscription alone keeps the
   device at ~3 s cadence for at least 20 min after the app is closed, so the get is not a
   keep-alive but a cheap **full-frame refresh** (all 31 fields on `get_reply`) and a staleness
   probe. `EnergyStreamSwitch` (96/97) had no measurable effect and is off by default
   (`--stream-interval 0`), kept as an option in case the 24 h soak shows throttling (R §4.5).
6. Decode every incoming frame: `HeaderMessage` → per-header `pdata` XORed with `seq & 0xFF` →
   dispatch on `(cmd_func, cmd_id)`; only `(254, 21) DisplayPropertyUpload` is mapped in 0.1.0;
   everything else is logged once at `debug` with hex (R §4.4, §4.5, E-7).
7. Publish changed items via the core (`{val, ts, lc}` retained). `connected` = `2` while a frame
   arrived within the last `--timeout` s (default 300), else `1` (E-5).
8. Login/certification errors → retry with backoff, never wipe credentials (R §4.1, outages look
   like bad passwords); MQTT auth error → re-run steps 1–3 once, then backoff.

---

## 3. Implementation spec

### 3.1 Files

```
ecoflow2mqtt/
├── index.js               createAdapter + wiring (login → mqtt → decode → publish)
├── lib/
│   ├── config.js          parseConfig: options below
│   ├── items.js           item table: {item, unit, protoField, haClass}  (3 rows in 0.1.0)
│   ├── app/
│   │   ├── login.js       auth/login + certification, region → host table, retry/backoff
│   │   └── mqtt.js        cloud MQTT client, subscribe, keep-alive timers, reconnect
│   ├── proto/
│   │   ├── header.proto   HeaderMessage (vendored, Apache-2.0 header kept — R §7)
│   │   ├── bk_series.proto  DisplayPropertyUpload subset + EnergyStreamSwitch
│   │   └── decode.js      buffer → HeaderMessage → XOR → {cmdFunc, cmdId, seq, message}
│   ├── capture.js         --capture <dir>: raw frames as base64 lines, SN scrubbed (E-2)
│   └── hadiscovery.js     items → HA sensor entities
├── test/                  decode fixtures (scrubbed base64), XOR, header, item mapping, config
├── RESEARCH.md · ROADMAP.md · README.md
```

Dependencies: `mqtt-interfaces-core ^0.8`, `mqtt`, `protobufjs ≥ 7` (proto3 `optional`, R §7).
HTTP via built-in `fetch` (Node ≥ 20.19). Plain JS, ESM, no TypeScript (D-4).

### 3.2 Options (`parseConfig`, env prefix `ECOFLOW2MQTT_`, plus the canonical core set)

| option              | env / notes                                                                        | type   | default                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `--email`           | EcoFlow app account                                                                | string | required                                                                                   |
| `--password`        | app account password, `secret: true`                                               | string | required                                                                                   |
| `--sn`              | inverter serial number (the device is bound to this account), `secret: true` (E-2) | string | required                                                                                   |
| `--region`          | `eu` \| `us` \| `cn` \| … → `api-e.ecoflow.com` / `api.ecoflow.com` / … (R §4.1)   | string | `eu`                                                                                       |
| `--api-host`        | override the host derived from `--region`                                          | string | —                                                                                          |
| `--mqtt-host`       | override the broker host returned by certification (wrong-region bug, R §4.1)      | string | —                                                                                          |
| `--poll`            | seconds between protobuf _get_ full-frame refreshes (E-9); 0 disables              | number | 60                                                                                         |
| `--stream-interval` | seconds between `EnergyStreamSwitch` frames; 0 disables (default, E-9)             | number | 0                                                                                          |
| `--timeout`         | seconds without a frame before `connected` drops to `1`                            | number | 300                                                                                        |
| `--capture`         | directory: append every raw frame as base64 (+ meta) for fixtures, SN scrubbed     | string | —                                                                                          |
| `--client-id-file`  | where the persisted UUID for `ANDROID_<UUID>_<userId>` lives (E-6)                 | string | `/etc/ecoflow2mqtt/<name>.clientid` when installed, else `~/.ecoflow2mqtt/<name>.clientid` |

`--name` defaults to `ecoflow`. Installer: `createInstaller` → `ecoflow2mqtt@<name>` template unit,
`/etc/ecoflow2mqtt/<name>.env` (mode 600, holds email/password/sn).

### 3.3 Decoding rules

- A `DisplayPropertyUpload` is **incremental** (every ~2 s) with a full frame every ~120 s (R §2):
  a frame may carry only some of the three fields. Publish only fields present in the frame; the
  core keeps `lc` correct.
- Values are floats already in W (R §4.5) — no scaling.
- `pv_watts` = last known pv1 + pv2, re-published whenever either input changes; if a frame ever
  carries `pow_get_pv_sum` (517) that value wins (E-4). Rounded to 1 decimal.
- **Verified 2026-08-28 (OQ-E2 closed):** the device sends `pow_get_pv` (361) and `pow_get_pv2`
  (70) as floats in W in every full frame and in incrementals when they change; 517 is never sent.
  Volts/amps (380/381, 442/71) are sent too and stay unpublished until 0.2.0; the `W = V × A`
  fallback is therefore not needed — keep the fields in the proto, drop the fallback logic.
- Full frame = 31 fields, ~155 bytes, sent as `get_reply` to every protobuf get and on its own
  every ~120 s; incrementals every 2–6 s carry only changed fields (often just RSSI 602).
- Frames whose header `device_sn` ≠ `--sn` are ignored (shared accounts, R §4.3 topic is per SN
  anyway).
- Unknown `(cmd_func, cmd_id)` → one `debug` line with hex per pair per process lifetime (E-7).

### 3.4 Tests (0.1.0)

- `decode.test.js`: captured, SN-scrubbed base64 frames → expected `{pv1, pv2, sum}`; XOR
  round-trip; multi-header frame; unknown cmd pair does not throw.
- `items.test.js`: mapping + fallback sum logic (§3.3), incremental frames.
- `login.test.js`: region → host table, error mapping (wrong region, outage ≠ wipe credentials),
  with mocked `fetch`.
- `config.test.js`: required options, `--config-schema` marks `password` and `sn` as `x-secret`.
- Installer smoke test as in the other adapters.

---

## 4. Decisions

| ID  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-1 | **Path B (app-account MQTT + protobuf) first**, because it is the only cloud path that reliably covers the STREAM Micro (R §0). The official Developer API (path A) is added later behind the same item table if a one-off test shows it works for this SN (R §1, error 1006), not planned on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| E-2 | **Nothing that identifies the author's device or account is committed.** RESEARCH.md records the SN _prefix_ only (`BK01Z…`). Captured frames (`--capture`, test fixtures) have the header `device_sn` and any `sn` string replaced by `BK01ZXXXXXXXXXXX` before they enter `test/`; the capture module does this itself so raw captures never need manual editing. `--sn`, `--email`, `--password` are `secret: true`; logs print the SN masked (prefix 5 + last 2, e.g. `BK01Z…9K`) at `info`, full only at `debug`. The account's 19-digit **user id** is an identifier too: `--capture` replaces it in topics (found in the first live run, 2026-08-28), and it never appears in `<name>/info` or in discovery payloads. EcoFlow's default `deviceName` embeds the last digits of the SN — it is never printed in README examples, issues or `info`. `.gitignore` covers `*.env`, `captures/`. |
| E-3 | **Item names** `pv1_watts`, `pv2_watts`, `pv_watts` (snake_case + unit suffix, as in the fleet's `_watts`/`_volts` convention and R §8); later items follow the same pattern (`grid_watts`, `pv1_volts`, …).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| E-4 | **Total = pv1 + pv2, computed by the adapter.** The STREAM Micro firmware seen on 2026-08-28 never sends `pow_get_pv_sum` (517); if a future firmware does, the device value wins. `grid_connection_power` (616) is the AC output, not the PV sum (a few W lower) and is a separate item in 0.2.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| E-5 | **`connected` 2 from push recency**, not from the cloud's online flag (which lags ~15 min, R §3.2). `--timeout` default 300 s (> 2 full-upload periods).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| E-6 | **Stable MQTT clientId.** The UUID in `ANDROID_<UUID>_<userId>` is generated once and persisted (`--client-id-file`), so reconnects do not pile up sessions on EcoFlow's broker (R §8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| E-7 | **Protocol as data.** `.proto` files are vendored text loaded with `protobufjs.parse` at runtime; the item table is a plain array; unknown command pairs are logged with hex instead of being errors — new firmware fields become a table row, not a code change (R §4.6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| E-9 | **No keep-alive needed on this path.** Measured 2026-08-28 with the app closed for 10–20 min: a plain subscriber gets ~18 incremental frames/min (max gap 10 s), same as with the app open; a protobuf get every 60 s or `EnergyStreamSwitch` every 20 s changed nothing. The throttling reported for the official API / after ~5 min (R §2) did not occur on the app-MQTT path in 20 min. Decision: `--poll 60` get stays as full-frame refresh, `EnergyStreamSwitch` off by default; re-check over 24 h (OQ-E1).                                                                                                                                                                                                                                                                                                                                                                                 |
| E-8 | **Single device per instance** in 0.x. `<name>/status/<item>` without a device segment. A bridge layout (`status/<dev>/<item>`) would be a breaking topic change, so it is decided before 1.0 (OQ-E5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

---

## 5. Milestones

### 0.0.1 — placeholder ✅ (2026-08-27)

Package name reserved on npm; `index.js` prints a pointer and exits 1.

### 0.1.0 — PV power only (the current goal)

- [x] Verification on the real device (§6) — three capture runs, 2026-08-28
- [x] `lib/app/login.js` (login, certification, region table, typed errors) + tests
- [x] `lib/proto/*.proto` vendored, `decode.js` (header → XOR → dispatch) + fixture tests
- [x] `lib/capture.js` with SN scrubbing (E-2); the fixtures in `test/fixtures/` came out of it
- [x] `lib/app/mqtt.js`: connect with persisted clientId, subscribe, refresh timers, reconnect,
      re-authenticate on auth error, backoff 10 s → 300 s
- [x] `lib/items.js` (3 rows) + computed total (E-4) + tests
- [x] `index.js` on `createAdapter`, `connected` from push recency (E-5)
- [x] HA discovery: three `sensor` entities, one HA device per inverter
- [x] `createInstaller`, env file with mode 600
- [x] README: setup (app account, region, SN), topics, options, the privacy note (E-2), the
      "unofficial API, may change" warning (R §4.6)
- [x] 82 unit tests, eslint + prettier clean
- [x] Live run 2026-08-28: PV values on the broker within a second of start, ~3 s cadence, no
      warnings, `product_id 17409` in `info`, client id reused after restart
- [ ] 24 h soak: cadence stays at ~2–6 s without the app open, no session pile-up, memory flat
- [ ] Publish 0.1.0 to npm

### 0.2.0 — the rest of the STREAM Micro readings ✅ (2026-08-28)

- [x] `grid_watts`, `grid_status`, `pv1_volts/_amps`, `pv2_volts/_amps`, `grid_volts/_amps/_hz`,
      `feed_limit_watts`, `feed_limit_max_watts`, `wifi_rssi` — 15 items, all rows in the table,
      no new mechanism (E-7 holds up: the change is `bk_series.proto` plus `items.js`).
- [x] Per-row `precision` (mains volts 1 decimal, string currents 2, RSSI integer) and a `map` for
      the enum item; `measurement: false` marks the limits as settings, not readings.
- [x] Discovery: power + status primary, the rest `diagnostic`; `grid_status` as an HA enum sensor
      with its options; no `state_class` on the limits; icons only where no device class implies one.
- [x] `RuntimePropertyUpload` (254/22) decoded — **no temperatures**, it carries the upload periods
      (full 120 s, incremental 2 s, matching R §2). Logged once at debug, contributes no items.
- [x] 92 tests, of which the decode and item tests run against the captures; live run 2026-08-28:
      all 15 items on the broker, `grid_volts` 238 V, `grid_hz` 50, `grid_status` `feed_grid`.
- [x] **OQ-E3 closed:** `BatchEnergyTotalReport` (254/32) never appeared in ~20 minutes of frames,
      so the device sends no energy counters. No kWh item; the README points at HA's Riemann sum.

### 0.3.0 — finding the inverter ✅ (2026-08-29)

- [x] `--discover` and `--sn auto` on the core's discovery module (B-2, core 0.11.x). There is
      nothing on the LAN to scan — the inverter only ever talks to EcoFlow — so this is the core's
      `cloud` hint: `GET /iot-service/user/device` lists what the account owns, and the serial is
      what `--sn` gets. `x-discover: "cloud"` in `--config-schema` is what she reads to offer it
      when an instance is added; before this the adapter offered nothing there.
- [x] Two things the core had to grow for it (0.11.0): `hint.needs`, because `--discover` normally
      drops mandatory options and this scan _is_ an account login, so `--email` and `--password`
      stay demanded while `--sn` — the option it fills — stays exempt; and cloud failures that
      propagate, so a wrong password says so instead of being reported as an empty result.
      0.11.1 then dropped `--discover-address` / `--discover-ip` from a cloud-only adapter's
      `--help`, where a subnet to sweep is meaningless.
- [x] `deviceList()` tolerates both documented response shapes (`data.bound` keyed by SN, which is
      what the real account returns, and a plain list): the endpoint is unofficial and the notes
      disagree. `online` is reported, never used to filter — EcoFlow's flag lags ~15 min and an
      inverter dark at night is still the one to configure.
- [x] 104 tests. Verified live against the real account on mqtt-ifaces.
- Groundwork for **bridge mode** (§7): listing the account's devices is the half that mode needs.

### 0.4.0 — settables

`set/feed_limit_watts` (`cfg_feed_grid_mode_pow_limit`) and `set/inv_target_watts`
(`cfg_inv_target_pwr`) via `ConfigWrite` (254/17) with ack (254/18) → HA `number` entities
(R §4.5). Needs the exact packet header for the BK01 (`product_id`, `version`) — captured from what
the app sends on `…/thing/property/set` (R §6).

### 0.5.0 — official Developer API as second transport (`--mode official`)

Only if the 1006 test passes (§6 item 4). HMAC signer with the official test vector (R §3.2),
`/open/<account>/<sn>/quota` + `latestQuotas` keep-alive (R §3.4), same item table keyed by
official field names (`powGetPv`, `powGetPv2`, `powGetPvSum` / `plugInInfoPv*`).

### 1.0.0

Topic layout final (OQ-E5 decided), both transports or the app path declared the only one,
PowerStream support at least data-driven (§7), spec version stated in `info`.

---

## 6. Verify on the real device first (before writing `items.js`)

Throw-away script in the scratchpad (not committed), 0.1.0 depends on the answers:

1. ✅ Login on `api-e.ecoflow.com` works; region = `eu`. `/iot-service/user/device` returns
   `data.bound` as an **object keyed by SN** (not an array): `{deviceName, model, productType: 55,
online, productSkuId, createTime}` — STREAM Micro = `productType 55`.
2. ✅ Certification host `mqtt-e.ecoflow.com:8883`, account `app-…`.
3. ✅ Frames: `254/21 DisplayPropertyUpload` (src 2 → dest 32, `enc_type 1`, XOR `seq & 0xFF`,
   `product_id 17409`, `version 3`), `254/22 RuntimePropertyUpload` (22 bytes: upload periods
   120000/2000/300000/60000 ms), `254/18` ConfigWrite acks (`product_id 14084`) when the app sets
   things. Fields 361/70 present, 517 absent (OQ-E2 closed). Field list of a full frame:
   70, 71, 133 (=200), 134 (string, timezone `Europe/Berlin`), 135, 361, 371 (=32), 380, 381,
   442, 521 (=600 feed limit W), 602, 613–620, 627, 638, 727 (=600), 728–734, 978.
   Cadence: app open ~3 s avg; app closed 10–20 min, purely passive subscriber: 147 frames in
   8 min, avg 3.2 s, max gap 10.3 s — **no throttling**; get every 60 s / `EnergyStreamSwitch`
   every 20 s: no change (E-9). pv1/pv2 values themselves update 1–12 times per minute (only on
   change; cloudy day, ~55 W per input).
4. ⬜ Official API, one call: `/device/quota/all?sn=…` → data or error 1006 (decides 0.5.0).
   Needs developer-platform keys, not done.
5. ⬜ Long-term: does the stream ever throttle without app/get (24 h soak, OQ-E1)? `--timeout` 300 s stays.

---

## 7. Backlog

- **PowerStream (`HW51`) support**: vendored `powerstream.proto`, `InverterHeartbeat` (20/1)
  with ×0.1 scaling, battery items, `permanent_watts` / `supply_priority` settables (R §4.4, §8).
  Untestable without a device — keep it data-driven, ask for captures in the README.
- **Bridge mode**: all devices of the account, `status/<dev>/<item>` (E-8, OQ-E5).
- **Local broker mode** (`--mode local`): DNS-redirect the device's MQTT to Mosquitto, decode the
  same protobuf; proven for PowerStream, unproven for STREAM (R §5.1).
- **BLE**: cloud-free, separate project if ever (R §5.2).
- **"Enhanced" certification** (`/iot-auth/enterprise-development/user/certification`, AES-CFB,
  WSS 8084) as a second door if EcoFlow closes `app/certification` (R §4.1).
- **`heartbeat_frequency` write** — nobody has shown the device honours it (R §9 item 6).

---

## 8. Open questions

| ID    | Question                                                                                                                                                                                                     | Resolve by          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| OQ-E1 | ~~Is a keep-alive required?~~ **Not within 20 min** (E-9). Open: does throttling appear after hours/days of no app use? Watch the 24 h soak (cadence per hour); if yes, `--stream-interval` goes back to 20. | 24 h soak, 0.1.0    |
| OQ-E2 | ~~Does this firmware send `pow_get_pv`/`pow_get_pv2`/`pow_get_pv_sum`, or only volt/amp?~~ **Closed 2026-08-28:** 361 + 70 yes, 517 never, volt/amp also present.                                            | done                |
| OQ-E3 | Does the STREAM Micro send `BatchEnergyTotalReport` (Wh per PV input) — worth an energy item in 0.2.0?                                                                                                       | capture, 0.2.0      |
| OQ-E4 | ~~Is `pow_get_pv_sum` exactly pv1 + pv2?~~ **Moot:** 517 is never sent; total is computed (E-4). `grid_connection_power` ≈ pv1 + pv2 minus ~1 %.                                                             | done                |
| OQ-E5 | Single device vs bridge topic layout before 1.0 (E-8). Does anyone run more than one STREAM Micro on one account?                                                                                            | before 1.0.0        |
| OQ-E6 | Rate/ban risk of the app path with a 24/7 client (ioBroker warns, no case known, R §4.6). Decide whether `--poll` defaults should be more conservative (e.g. 60/30 s).                                       | after the 24 h soak |
