# ecoflow2mqtt — research: getting continuous PV readings out of an EcoFlow micro-inverter

Research date: 2026-08-26. Everything below was verified against primary sources (official
developer docs decoded from the portal's JS bundle, source code of the reference implementations,
GitHub issues, forum threads). Items that could not be verified are marked **[uncertain]**.
Cloned copies of the reference repos were kept in the (ephemeral) session scratchpad
(`repos/`, `ha-ef-ble`, `ecoflow-energy-ha`); every fact cites the upstream repo path so it can be re-fetched.

---

## 0. TL;DR

**Yes, continuous PV readings are possible — three independent ways, all in use by others today.**
The reason people think "there is no way" is that EcoFlow devices _throttle their telemetry pushes
when nobody is watching_; the app keeps the stream alive by periodically sending a "get / latestQuotas"
request (or, for the STREAM family, an "EnergyStreamSwitch" activate frame). Replicate that and you
get the same 1–5 s cadence the app shows.

| Path                                                 | Cloud?                           | Cadence                                                           | PowerStream (HW51)                            | STREAM Microinverter (BK01/BK02/N011)                                                                           | Effort in Node.js                                 | Risk                                                       |
| ---------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| **A. Official Developer API** (HTTP + MQTT, JSON)    | yes                              | ~1–2 s while "pulled" every ≤20 s; else minutes                   | ✅ documented                                 | ⚠️ works for some via `/open/.../quota` but _not documented_; some accounts get error 1006 "device not allowed" | low (HMAC signing, JSON)                          | low — official, but read-mostly and rate-limited           |
| **B. App-account MQTT** (unofficial, protobuf)       | yes                              | ~2 s (PowerStream), 5–6 s (STREAM Micro) while polled every ≤60 s | ✅                                            | ✅ (only cloud path that reliably covers it)                                                                    | medium (login + protobufjs + XOR)                 | medium — unofficial, "may change", but stable since 2023   |
| **C1. Local: DNS-redirect device MQTT → own broker** | no                               | device's native heartbeat (~1–2 s)                                | ✅ proven (device does _not_ verify TLS cert) | ❓ unproven                                                                                                     | medium (run TLS broker + protobuf decode)         | Wi‑Fi module of PowerStream reported flaky; STREAM unknown |
| **C2. Local: Bluetooth LE**                          | no (one-time login for `userId`) | 30 s requested heartbeat (PowerStream), 1–10 s push (STREAM)      | ✅                                            | ✅                                                                                                              | high (port ECDH/AES handshake to Node, BLE stack) | only one BLE central at a time, ~10 m range                |

**Recommendation for ecoflow2mqtt (device = STREAM Microinverter `BK01…`, see §1):** start with
**B (app-account MQTT + protobuf)** — the only cloud path that reliably covers the STREAM Micro — with
the keep-alive logic (`latestQuotas`/protobuf get every 60 s + `EnergyStreamSwitch` 96/97 every 20 s).
Add **A** behind the same item table if a one-off test shows `/device/quota/all` returns data for
this SN instead of error 1006. **C1** (local broker) is unproven for STREAM; BLE (C2) is the
cloud-free fallback but a separate project.

---

## 1. First: which device do you actually have?

**Answer (2026-08-26): STREAM Microinverter, SN prefix `BK01Z…` (EU "Z" unit; full SN deliberately not recorded here).**
Consequences: the official Developer API has _no_ documentation for it and refuses it for some
accounts (error 1006) — worth one test call, but do not plan on it. The reliable paths are
**B (app-account MQTT, protobuf `cmd_func 254 / cmd_id 21 DisplayPropertyUpload`, XOR by
`seq & 0xFF`)** and **C2 (BLE)**. It has no battery port, so the item table is PV1/PV2 W/V/A,
PV sum, grid W/V/A/Hz + status, feed-in limit, Wi‑Fi RSSI, and two settables
(`cfg_feed_grid_mode_pow_limit`, `cfg_inv_target_pwr`).

Two completely different products are called "EcoFlow micro-inverter":

|                          | **PowerStream** (2023)                                          | **STREAM Microinverter** (2025, part of the STREAM family)                                                    |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| SN prefix                | `HW51…` (smart plug = `HW52`)                                   | `BK01…`, `BK02…`, US: `N011…`                                                                                 |
| BLE name                 | `EF-HW…`                                                        | `EF-BK…`                                                                                                      |
| Battery port             | yes (Delta/River)                                               | no — pure grid-tie                                                                                            |
| Official API doc page    | `developer-eu.ecoflow.com/us/document/powerStreamMicroInverter` | not documented; STREAM doc (`bkw`) lists Ultra/Pro/AC/AC Pro/Ultra X/Max only                                 |
| Cloud protobuf           | `cmd_func 20 / cmd_id 1 InverterHeartbeat` (int32 ×0.1 scaling) | `cmd_func 254 / cmd_id 21 DisplayPropertyUpload` (floats, XOR-obfuscated)                                     |
| Official API field names | `20_1.pv1InputWatts`, `pv2InputWatts`, `invOutputWatts`…        | `powGetPvSum`, `powGetPv`/`powGetPv2` (old fw) or `plugInInfoPvVol/Amp` (fw ≥1.0.1.88), `gridConnectionPower` |

Check the serial number on the device / in the app. Everything below is written for both, but the
"which path works" answer differs (see the TL;DR table). Note tolwi issue #798: adding a `BK01`
device as "PowerStream" silently fails because the decoder differs.

---

## 2. Why the app shows live values (the core mechanism)

Verified from the reference implementations and 2026 issue reports:

1. Devices publish telemetry ("heartbeat") to EcoFlow's broker. PowerStream's heartbeat carries a
   `heartbeat_frequency` field (official sample: `"heartbeatFrequency": 2`). STREAM Micro diagnostics
   show `displayPropertyIncrementalUploadPeriod = 2000 ms`, `displayPropertyFullUploadPeriod = 120000 ms`.
2. **The device (or the cloud) throttles pushes when no client is actively asking.** Reports:
   - openHAB (official API, STREAM Micro): "updates are only received while the EcoFlow app is open.
     Without the app … maybe every 13–16 min" — https://community.openhab.org/t/ecoflow-stream-new-generation/169033
   - tolwi #704 (2026-03, PowerStream): values only refresh after opening the iPhone app.
   - tolwi #830 (2026-06, STREAM): pushes stop ~5 min after closing the app; a protobuf _get_ every
     ~60 s to each SN keeps the stream alive.
   - tolwi PR #881 (2026-08, STREAM Micro): one push every 5–6 s while the app is open.
3. **The app keeps the stream alive by polling.** Reverse-engineered from the Android app's
   `MqttManager.fetchAllDeviceData` (MichelFR/ha-ecoflow-iot `const.py`): every ~20 s it publishes
   ```json
   {"id": 1712345678901, "version": "1.1", "moduleType": 0, "operateType": "latestQuotas", "params": {}, "sn": "<SN>"}
   ```
   to the device's `get` topic. For the STREAM family shuette42/ecoflow-energy-ha additionally sends an
   **EnergyStreamSwitch** protobuf frame (`cmd_func 96 / cmd_id 97`, inner field 1 = `1`) "after every
   MQTT connect and periodically every 15–25 s to keep the stream alive".
4. Reference bridges that get app-like cadence therefore run: `latestQuotas` every 20–60 s
   (+ EnergyStream activate every 20 s for STREAM) + an HTTP `quota/all` fallback when the stream
   goes silent > 60–120 s + reconnect with re-certification.

That is the whole "secret". Everything else is plumbing.

---

## 3. Path A — Official EcoFlow IoT Developer Platform

### 3.1 Access

- Portals: global `https://developer.ecoflow.com/us/`, EU `https://developer-eu.ecoflow.com/us/`.
  API hosts: `https://api.ecoflow.com` (global/US), `https://api-e.ecoflow.com` (EU), `api-a` (Americas
  in some code). **Accounts are region-bound** — an EU app account must use the EU portal/host; wrong
  host → `accessKey is invalid` / "Account doesn't exist".
- Log in with the normal app account → "Become a Developer" → manual review (reports: 2 days to a
  week; approval mail "Approval notice from EcoFlow Developer Platform") → create `accessKey`/`secretKey`
  under `/us/security`.
- `/device/list` "only returns the device bound to itself, not by share" → use the account the device
  is bound to. Keys don't expire; regenerating keys yields a new MQTT `certificateAccount`.

### 3.2 HTTP API (`${host}/iot-open/sign/...`)

Headers on every request: `accessKey`, `nonce` (6-digit random int), `timestamp` (UTC ms), `sign`.

Signature (official "generalInfo" doc):

1. Flatten params to `key=value`, sort by ASCII. Nested objects with dots, arrays with `[i]`:
   `params.cmdSet=11&params.eps=0&params.id=24&sn=123456789`
2. Append `&accessKey=…&nonce=…&timestamp=…`
3. `sign = hex(HMAC-SHA256(secretKey, string))` — no URL encoding, booleans as `true/false`.
4. Official test vector: accessKey `Fp4SvIprYSDPXtYJidEtUAd1o`, secretKey `WIbFEKre0s6sLnh4ei7SPUeYnptHG6V`,
   nonce `345164`, ts `1671171709428`, body `{"sn":"123456789","params":{"cmdSet":11,"id":24,"eps":0}}`
   → `07c13b65e037faf3b153d51613638fa80003c4c38d2407379a7f52851af1473e`. Use it as a unit test.
   Clock skew → code 8521 "signature is wrong".

| Method | Path                         | Purpose                                                                                                                                |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/device/list`               | `{"code":"0","data":[{"sn","deviceName","online":1}]}` (`online` lags up to ~15 min)                                                   |
| GET    | `/device/quota/all?sn=SN`    | full quota map, keys like `"20_1.pv1InputWatts"`; server-cached, returns even when offline; **empty for STREAM Micro** (tolwi PR #881) |
| POST   | `/device/quota`              | `{"sn","params":{"quotas":["20_1.permanentWatts"]}}`                                                                                   |
| PUT    | `/device/quota`              | `{"sn","cmdCode":"WN511_SET_PERMANENT_WATTS_PACK","params":{"permanentWatts":20}}`                                                     |
| GET    | `/certification`             | MQTT credentials                                                                                                                       |
| GET    | `/device/system/main/sn?sn=` | STREAM only — master SN of a multi-device system                                                                                       |
| POST   | `/device/quota/data`         | STREAM only — historical energy series (day granularity)                                                                               |

Rate limits: **not documented**. No 429 reports found. The "10 per day" people quote is the MQTT
client-ID limit (below). Treat HTTP polling ≥ 30 s as safe; MichelFR polls 60 s as fallback.

### 3.3 Official MQTT

`GET /iot-open/sign/certification` →

```json
{
  "code": "0",
  "data": {
    "certificateAccount": "open-57c13…",
    "certificatePassword": "9592…",
    "url": "mqtt.ecoflow.com",
    "port": "8883",
    "protocol": "mqtts"
  }
}
```

(EU keys → `mqtt-e.ecoflow.com`). Username/password = certificateAccount/Password, TLS 8883, public CA.

Topics: `/open/${certificateAccount}/${sn}/quota` (telemetry), `/status`, `/set`, `/set_reply`,
`/get`, `/get_reply`. Status payload `{"id":"…","version":"1.0","timestamp":…,"params":{"status":0|1}}`.
Reply codes: `0` ok, `-1` device not owned, `-2` offline.

PowerStream quota message on `/quota` (official sample; note `param` singular, bare keys):

```json
{
  "cmdId": 1,
  "cmdFunc": 20,
  "param": {
    "pv1InputWatts": 0,
    "pv2InputWatts": 0,
    "invOutputWatts": 0,
    "batInputWatts": 0,
    "permanentWatts": 3200,
    "dynamicWatts": 0,
    "pv1InputVolt": 0,
    "pv1InputCur": 0,
    "pv1OpVolt": 0,
    "pv1Temp": 350,
    "invOpVolt": 0,
    "invOutputCur": 0,
    "invFreq": 0,
    "batSoc": 80,
    "batInputVolt": 524,
    "batInputCur": 0,
    "batTemp": 270,
    "ratedPower": 6000,
    "heartbeatFrequency": 2,
    "supplyPriority": 1,
    "lowerLimit": 22,
    "upperLimit": 83
  }
}
```

HTTP uses `data` with `20_1.`-prefixed keys instead.

Units (official table + implementations; the doc table omits the *Watts fields, scaling inferred from
`permanentWatts: 3200 = 320 W`, `ratedPower: 6000 = 600 W`, `pv1Temp: 350 = 35.0 °C`):

| key                                                                                                                                                                 | scale                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pv1InputWatts`, `pv2InputWatts`, `invOutputWatts`, `batInputWatts` (+ discharge / − charge), `dynamicWatts`, `permanentWatts`, `ratedPower`, `pvPowerLimitAcPower` | ×0.1 W                                                                                              |
| `pv1InputVolt`, `pv2InputVolt`, `batInputVolt`, `invOpVolt`, `invInputVolt`                                                                                         | ×0.1 V                                                                                              |
| `pv1OpVolt`, `pv2OpVolt`                                                                                                                                            | ×0.01 V (tolwi/ioBroker)                                                                            |
| `pv1InputCur`, `pv2InputCur`, `batInputCur`                                                                                                                         | doc says 0.1 A; tolwi treats `batInputCur`/`invOutputCur` as mA — **[uncertain, verify on device]** |
| `pv1Temp`, `batTemp`, `invTemp`                                                                                                                                     | ×0.1 °C                                                                                             |
| `invFreq`                                                                                                                                                           | ×0.1 Hz                                                                                             |
| `batSoc`, `lowerLimit`, `upperLimit`                                                                                                                                | %                                                                                                   |
| `supplyPriority`                                                                                                                                                    | 0 = power supply priority, 1 = charge priority                                                      |
| `heartbeatFrequency`                                                                                                                                                | raw                                                                                                 |

Set (MQTT `/set`): `{"id":123456789,"version":"1.0","cmdCode":"WN511_SET_PERMANENT_WATTS_PACK","params":{"permanentWatts":3200}}`
→ `set_reply` `{"data":{"ack":0},"id":123456789}`. cmdCodes: `WN511_SET_SUPPLY_PRIORITY_PACK {supplyPriority}`,
`WN511_SET_PERMANENT_WATTS_PACK {permanentWatts 0–6000 (0.1 W)}`, `WN511_SET_BAT_LOWER_PACK {lowerLimit 1–30}`,
`WN511_SET_BAT_UPPER_PACK {upperLimit 70–100}`, `WN511_SET_BRIGHTNESS_PACK {brightness 0–1023}`,
`WN511_DELETE_TIME_TASK {taskIndex}`.

STREAM family (`bkw` doc; SN `BK…`): plain floats, no scaling: `powGetPvSum` (W), `gridConnectionPower`
(W; doc says feed-in negative, firmware reports feed-in positive per MichelFR), `powGetSysGrid`,
`powGetSysLoad`, `powGetBpCms`, `cmsBattSoc`, `feedGridMode` (1 off / 2 on), `relay2Onoff`,
`quota_cloud_ts` ("Heartbeat report time"). Per-string PV is undocumented but present: old fw
`powGetPv`…`powGetPv4`, fw ≥1.0.1.88 `plugInInfoPvVol/Amp`, `plugInInfoPv2Vol/Amp` (W = V×A;
tolwi `stream_pv_helpers.py`). Also seen: `gridConnectionVol/Amp/Freq`, `invNtcTemp3`,
`moduleWifiRssi`, `feedGridModePowLimit`. Control: `cmdId:17, cmdFunc:254, dirDest:1, dirSrc:1,
dest:2, needAck:true, params:{cfg…}`.

### 3.4 Keeping it continuous (the important part)

Publish to `/open/${account}/${sn}/get` every ≤20 s:

```json
{"id":<ms>,"version":"1.1","moduleType":0,"operateType":"latestQuotas","params":{},"sn":"<SN>"}
```

Replies land on `get_reply` (full snapshot under `data`) and/or `quota`. Add: HTTP `quota/all` fallback
after ~120 s of silence; force-reconnect after 3 stale polls; re-fetch `/certification` on auth failure
(MichelFR/ha-ecoflow-iot does exactly this and reports "live MQTT updates within seconds").

### 3.5 Limits / pain points (official path)

- **~10 unique MQTT client IDs per day per key** (EcoFlow FB group, quoted in tolwi `public_api.py`);
  exceeding → CONNACK rc 5, only fix = new keys (tolwi #306, #351). → fixed `clientId`, `clean: true`.
- **One consumer per key** — parallel use "disturbs event updates" (openHAB binding docs). Give
  ecoflow2mqtt its own key pair.
- Docs omit the PowerStream power fields and all STREAM per-string fields; field names change with
  firmware (STREAM 1.0.1.41 / 1.0.1.88).
- EcoFlow selectively refuses devices: error **1006 "current device is not allowed to get device info"**
  for STREAM Micro / some Delta Max since mid-2025 (tolwi #540; shuette42 README: "Stream Micro:
  Enhanced Mode only (no Developer API exposure)"). Yet openHAB/tolwi users do get STREAM Micro data
  on `/open/.../quota` — so it depends on account/firmware. **[uncertain — test with your device]**
- Control latency up to ~90 s reported (tolwi discussion #414).
- March 2025 outage (tolwi #453) fixed by regenerating keys; sporadic socket disconnects persist.

### 3.6 Node.js code to reuse

- `@ecoflow-api/rest-client` + `@ecoflow-api/schemas` (rustyy, MIT, TS, zod; PowerStream schemas,
  `getMqttCredentials()`). Or copy the ~60-line signer from PietroLubini/homebridge-ecoflow
  `src/apis/ecoFlowHttpApiManager.ts:83-155`.
- MichelFR/ha-ecoflow-iot (Python, MIT) — best reference for the keep-alive/fallback state machine and
  per-device quota tables (`docs/devices/solar_systems/power_stream.md`, `stream_microinverter.md`).

---

## 4. Path B — Unofficial "app account" MQTT (what the app does)

Reverse-engineered in March 2023 (ioBroker forum), unchanged since apart from a client-ID filter.
Still working Aug 2026 (tolwi 1.7.x, foxthefox 1.4.9 releases this month).

### 4.1 Login → MQTT credentials

```http
POST https://api.ecoflow.com/auth/login      (EU accounts: api-e.ecoflow.com; also api-a/-j/-r/-cn)
content-type: application/json
lang: en_US

{"email":"<email>","password":"<base64(password)>","scene":"IOT_APP","userType":"ECOFLOW"}
```

Optional app-like extras: `"os":"android","osVersion":"30","appVersion":"4.1.2.02"`,
`"oauth":{"bundleId":"com.ef.EcoFlow"}`, headers `platform: android`, `version: 4.1.2.02`,
`user-agent: okhttp/3.14.9`. **No HMAC/signature on the app API**; no CAPTCHA/2FA reported.
Response: `{"code":"0","data":{"token":"<JWT>","user":{"userId":"<19-digit>","name":…}}}`.
Wrong region → "Account doesn't exist or incorrect password". Outages return the same error as bad
credentials (tolwi #902) → retry, don't wipe credentials.

```http
GET https://api.ecoflow.com/iot-auth/app/certification?userId=<userId>
authorization: Bearer <token>
```

→ `{"data":{"url":"mqtt.ecoflow.com","port":"8883","protocol":"mqtts","certificateAccount":"…","certificatePassword":"…"}}`
(EU → `mqtt-e.ecoflow.com`; occasionally the wrong region host is returned — make it overridable,
foxthefox #183).

Newer variant (shuette42 "enhanced mode", from the EcoFlow **web portal** JS):
`GET /iot-auth/enterprise-development/user/certification` → AES-CFB128-encrypted JSON, key =
`SHA256(JWT)`, IV = `"ojsajkqjwk1w2dfg"`, PKCS7; yields the same creds plus a **WSS endpoint on port
8084**. Not needed — the plain `app/certification` still works — but it is a second door if EcoFlow
closes the first.

Device list: `GET /iot-service/user/device` (Bearer) → `sn`, `deviceName`, `productType`, online.

### 4.2 MQTT connection

- `mqtts://<url>:8883`, TLS with public CA, username/password = certificate account/password.
- **clientId MUST be `ANDROID_<UUID>_<userId>`** (broker filters on it since 2023-03).
  tolwi: `ANDROID_${uuidHexUpper}_${userId}`; ioBroker: `ANDROID_${uuidv4()}_${userId}`.
- keepalive 15–60 s, clean session, QoS 1 for publishes.

| Purpose                    | Topic                                         |
| -------------------------- | --------------------------------------------- |
| telemetry push (subscribe) | `/app/device/property/<SN>`                   |
| set (publish)              | `/app/<userId>/<SN>/thing/property/set`       |
| set reply                  | `/app/<userId>/<SN>/thing/property/set_reply` |
| get / refresh (publish)    | `/app/<userId>/<SN>/thing/property/get`       |
| get reply                  | `/app/<userId>/<SN>/thing/property/get_reply` |

Delta/River publish JSON here; **PowerStream, Smart Plug and the whole STREAM family publish
protobuf.** Offline shows up as a header with `code == "-2"` or as silence.

### 4.3 Envelope (same for all protobuf devices)

```proto
syntax = "proto3";
message Header {
  bytes  pdata = 1;  int32 src = 2;  int32 dest = 3;  int32 d_src = 4;  int32 d_dest = 5;
  int32  enc_type = 6;  int32 check_type = 7;  int32 cmd_func = 8;  int32 cmd_id = 9;  int32 data_len = 10;
  int32  need_ack = 11; int32 is_ack = 12; int32 seq = 14; int32 product_id = 15; int32 version = 16;
  int32  payload_ver = 17; int32 time_snap = 18; int32 is_rw_cmd = 19; int32 is_queue = 20; int32 ack_type = 21;
  string code = 22; string from = 23; string module_sn = 24; string device_sn = 25;
}
message HeaderMessage { repeated Header header = 1; }   // one MQTT message may stack several
```

Decode: parse `HeaderMessage`, iterate, dispatch on `(cmd_func, cmd_id)`.
**XOR obfuscation:** if `enc_type == 1` (and `src != 32`), `pdata[i] ^= (seq & 0xFF)` before parsing
(foxthefox `ecoflow_utils.js` ~L337, tolwi `stream_microinverter.py`; verified on 54/54 STREAM frames).
PowerStream frames normally arrive unobfuscated; STREAM frames always XORed.

### 4.4 PowerStream messages

| cmd_func | cmd_id    | message                                                                                  |
| -------- | --------- | ---------------------------------------------------------------------------------------- |
| 20       | 1         | `InverterHeartbeat` (telemetry, incl. PV) — also sent _empty_ as the "get quota" request |
| 20       | 4         | `InverterHeartbeat2` (SoC etc.; newer fw no longer sends it)                             |
| 20       | 129       | `PermanentWattsPack {uint32 permanent_watts=1}` deci-watts 0–8000                        |
| 20       | 130       | `SupplyPriorityPack {uint32 supply_priority=1}`                                          |
| 20       | 132 / 133 | `BatLowerPack {int32 lower_limit=1}` / `BatUpperPack {int32 upper_limit=1}`              |
| 20       | 135       | `BrightnessPack {int32 brightness=1}`                                                    |
| 20       | 143       | `SetValue {int32 value=1}` = feed_protect                                                |
| 20       | 146       | `rated_power_pack`                                                                       |
| 32       | 11        | `CountryTownMessage` / "ping"                                                            |
| 254      | 32        | `BatchEnergyTotalReport` (Wh; `watth_type` 2 plugs, 3 to bat, 4 from bat, 7 PV1, 8 PV2)  |

`InverterHeartbeat` (field numbers; full 61-field proto in tolwi
`custom_components/ecoflow_cloud/devices/internal/proto/powerstream.proto`):

| #           | field                                                                                                                                                          | scale                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 11–15       | pv1_statue, pv2_statue, bat_statue, llc_statue, inv_statue (6 = grid-connected, 11 = disconnected)                                                             | raw                                    |
| 16 / 21     | pv1_input_volt / pv2_input_volt                                                                                                                                | ×0.1 V                                 |
| 17 / 22     | pv1_op_volt / pv2_op_volt                                                                                                                                      | ×0.01 V                                |
| 18 / 23     | pv1_input_cur / pv2_input_cur                                                                                                                                  | ×0.1 A                                 |
| **19 / 24** | **pv1_input_watts / pv2_input_watts**                                                                                                                          | **×0.1 W**                             |
| 20 / 25     | pv1_temp / pv2_temp                                                                                                                                            | ×0.1 °C                                |
| 26–31       | bat_input_volt (×0.1 V), bat_op_volt (×0.1 V), bat_input_cur (mA), bat_input_watts (×0.1 W, + discharge), bat_temp (×0.1 °C), bat_soc (%)                      |                                        |
| 35–41       | inv_input_volt (×0.01 V), inv_op_volt (×0.1 V AC), inv_output_cur (mA), **inv_output_watts (×0.1 W)**, inv_temp (×0.1 °C), inv_freq (×0.1 Hz), inv_dc_cur (mA) |                                        |
| 48 / 49     | permanent_watts / dynamic_watts                                                                                                                                | ×0.1 W                                 |
| 50–53       | supply_priority, lower_limit, upper_limit, inv_on_off                                                                                                          | raw                                    |
| 56–58       | inv_brightness, heartbeat_frequency, rated_power                                                                                                               | raw / raw / W or 0.1 W **[uncertain]** |
| 59–61       | chg_remain_time, dsg_remain_time (min), feed_protect                                                                                                           |                                        |

foxthefox's dictionary has many more fields from newer firmware (`pvToInvWatts`, `gridConsWatts`,
`plugTotalWatts`, `invToPlugWatts`, `spaceDemandWatts`, `acSetWatts`, `wifiRssi`, `staIpAddr`… all ×0.1 W)
— see `lib/dict_data/ef_pstream_data.js` (proto text ≈ line 2491). MIT, copy with attribution.

Set message (tolwi/ioBroker/rotflorg agree byte-for-byte): header `src=32, dest=53, d_src=1,
d_dest=1, check_type=3, cmd_func=20, cmd_id=<129…>, need_ack=1, seq=<Date.now()>, version=19,
payload_ver=1, from="ios", device_sn=<SN>, pdata=<pack>, data_len=len` → publish to `…/thing/property/set`.
Refresh ("latestQuotas"): header `src=32, dest=32, seq=Date.now(), from="ios"` (no pdata) →
`…/thing/property/get`; the device answers a full heartbeat on `get_reply`. Send it every 60 s
(ioBroker 5 min, rotflorg 60 s, tolwi #830 says ~60 s is what keeps STREAM alive).

### 4.5 STREAM Microinverter (BK series) messages

Observed push: `src=2, dest=32, cmd_func=254, cmd_id=21, product_id=17409`, pdata XORed with `seq & 0xFF`.

| cmd_func | cmd_id  | message                                                                              |
| -------- | ------- | ------------------------------------------------------------------------------------ |
| 254      | 21      | `DisplayPropertyUpload` (every 2 s incremental, full every 120 s)                    |
| 254      | 22      | `RuntimePropertyUpload`                                                              |
| 254      | 17 / 18 | `ConfigWrite` / ack (set)                                                            |
| 254      | 19 / 20 | `ConfigRead` / ack                                                                   |
| 32       | 2 / 50  | `CMSHeartBeatReport` / `BMSHeartBeatReport` (STREAM AC/Ultra with battery)           |
| 96       | 97      | `EnergyStreamSwitch {1: 1}` — **app→device "activate stream"**, resend every 15–25 s |

`DisplayPropertyUpload` PV subset (floats already in W/V/A/Hz; from tolwi `ef_bk_series.proto`,
rabits `bk_series.proto`):

| #                     | field                                                                |
| --------------------- | -------------------------------------------------------------------- |
| 361                   | `pow_get_pv` (PV1 W)                                                 |
| 70                    | `pow_get_pv2` (PV2 W)                                                |
| 380 / 381             | `plug_in_info_pv_vol` / `plug_in_info_pv_amp`                        |
| 442 / 71              | `plug_in_info_pv2_vol` / `plug_in_info_pv2_amp`                      |
| 517                   | `pow_get_pv_sum`                                                     |
| 616 / 613 / 614 / 615 | `grid_connection_power` / `_vol` / `_amp` / `_freq`                  |
| 619                   | `grid_connection_sta` (0 invalid, 1 grid in, 2 offline, 3 feed grid) |
| 602                   | `module_wifi_rssi`                                                   |
| 521 / 727             | `feed_grid_mode_pow_limit` / `feed_grid_mode_pow_max`                |

`ConfigWrite`: `cfg_utc_time = 6`, `cfg_inv_target_pwr = 220`, `cfg_feed_grid_mode_pow_limit = 169`;
packet `src 32 → dest 2, cmd_func 254, cmd_id 17, version 3, product_id 56 (Ultra)`.

### 4.6 Status / risks (app path)

- Only hardening so far: client-ID filter (2023-03). No CAPTCHA, signature, 2FA, device limit, or ban
  reported as of 2026-08.
- The dominant 2026 problem is the throttling described in §2 — solved by the periodic get.
- ioBroker README warns use "may lead to exclusion from the service"; no case known.
- EcoFlow "can change app-side protocols" (tolwi README). Mitigation: keep the protobuf schemas as data
  files; log unknown `(cmd_func, cmd_id)` with raw hex (foxthefox `lib/helper/protobufhelper.js` is a
  generic wire-format dumper worth porting).

---

## 5. Path C — Local / cloud-free

### 5.1 DNS-redirect the device's own MQTT to a local broker (PowerStream: proven)

tomvd/local-powerstream (Java, MIT) and RGarrett93/hassio-ecoflow-mqtt-decoder (+ `hassio-ap-ecoflow-dns-redirect`):

- PowerStream fw 1.1.4.61 resolves `mqtt-e.ecoflow.com` and connects to :8883 — with a Pi-hole/AdGuard
  DNS rewrite it connects to a local Mosquitto/EMQX **with a self-signed certificate; the device does
  not verify the broker cert**.
- It logs in with clientId `HW51…` (its SN), username `device-<32 hex>`, password `<32 hex>`
  (constant per device — capture once, then require auth or allow anonymous).
- It subscribes to `/sys/<sn>/thing/protobuf/downstream`, `/sys/<sn>/thing/rawData/downstream`,
  `/sys/<sn>/thing/property/{cmd,set}`, `/ota/wifi/*`, `/ota/module/*` and **publishes the same
  protobuf heartbeats** (§4.4) — so ecoflow2mqtt's app-path decoder works unchanged.
- Control works with header `src=32, dest=53, cmdFunc=20, cmdId=129, version=19, payloadVer=1, needAck=1`.
- Also redirect `pool.ntp.org` or the device may refuse to run without time (tolwi discussion #414).
- Caveats: the PowerStream Wi‑Fi module is widely reported as flaky (drops every 2–8 min in local
  setups; the cloud path "recovers" only because opening the app triggers a reconnect — Just-Zuul);
  other families (SHP/Delta Pro) went silent on a local broker (tolwi #261, discussion #88); **STREAM
  devices: unknown whether they verify certs or need a cloud handshake** [uncertain]. EcoFlow's own
  STREAM docs: "remote control and historical data logging are unavailable with Bluetooth or LAN only".

### 5.2 Bluetooth LE (both devices, fully documented in rabits/ha-ef-ble)

- Library: `custom_components/ef_ble/eflib/` (Apache-2.0, Python): `connection.py`, `encryption.py`,
  `packet.py`, `encpacket.py`, `keydata.py`, `login.py`, `pb/*.proto`, `devices/powerstream.py`,
  `devices/stream_microinverter.py`. ESP32 C++ port for PowerStream: Just-Zuul/Local-MQTT-EcoFlow-PowerStream-BLE-Bridge.
- Advertisement: manufacturer ID `0xB5B5`, bytes 1..17 = SN. GATT write `00000002-0000-1000-8000-00805f9b34fb`,
  notify `00000003-…` (fallback Nordic UART `6e400002/6e400003-…`).
- Handshake: ephemeral ECDH on **secp160r1** → AES-128-CBC (key = shared[:16], IV = MD5(shared)) →
  `getKeyInfoReq` returns 16-byte sRand + 2-byte seed → real session key derived via a ~3 KB static
  table from the app (`keydata.py`) → auth packet = hex(MD5(userId + SN)) (`src 0x21, dst 0x35,
cmd_set 0x35, cmd_id 0x86`). So you need the account **userId once** (from `/auth/login`, or
  https://gnox.github.io/user_id) and the device must be bound to that account. No cloud afterwards.
- Frame: `0xAA | ver | len u16 | crc8 | product | seq(4) | 0000 | src | dst | dsrc | ddst | cmd_set | cmd_id | payload | crc16-ARC`,
  wrapped in `0x5A5A` EncPacket frames. v0x13 payloads XORed with first seq byte.
- PowerStream: `src 0x35, cmd_set 0x14, cmd_id 0x01` = `inverter_heartbeat` (identical proto to cloud,
  ×0.1 scaling), requested every 30 s by the client (`_HEARTBEAT_INTERVAL = 30`; faster untested).
  Set: `0x81` permanent watts, `0x82` priority, `0x84/0x85` limits, `0x8F` feed protect, `0x92` AC max.
- STREAM Micro: `src 0x02, cmd_set 0xFE, cmd_id 0x15` = `DisplayPropertyUpload` pushed (1–10 s);
  `ConfigWrite` via `0x20→0x02, 0xFE/0x11, v0x13`.
- Constraints: one BLE central at a time (app via cloud still works), ~10 m range (ESP32 BLE
  proxies common), no JS port exists (would need noble/node-ble + `elliptic` with custom secp160r1
  params + `protobufjs` + the keydata blob).

### 5.3 Other local interfaces — nothing usable

- UDP 51008 PowerStream ⇄ Smart Plug traffic (undecoded; bussink.net, photovoltaikforum "Plug-Nachbau").
- STREAM Ultra X polls a local mDNS/HTTP meter (everHome EcoTracker emulation, wwerther) — meter side
  only, proves the firmware has local HTTP client code but exposes no PV data.
- Port 8055 byte-stream / port 80 config exist on Delta power stations (v1ckxy), not on inverters.
- No local API, Modbus, SunSpec, Matter (only Smart Plug/PowerInsight are Matter-certified) or HA
  partnership announced for PowerStream/STREAM as of 2026-08.

---

## 6. App reverse-engineering notes (if EcoFlow closes the doors above)

- Package `com.ecoflow`; regional hosts `api`, `api-a`, `api-e`, `api-j`, `api-r`, `api-cn` (phone login).
- Protobuf descriptors are extractable from the APK: aaa4xu/ecoflow-app-proto (apktool + `protodump`);
  rabits used JADX + Ghidra on the native lib + `protod`, BLE via rooted-phone btsnoop + Wireshark.
- Two certification endpoints exist (`/iot-auth/app/certification` plain; `/iot-auth/enterprise-development/user/certification`
  AES-CFB, IV `ojsajkqjwk1w2dfg`, key SHA256(token)) and two transports (mqtts 8883, wss 8084).
- App keepalives: `latestQuotas` JSON get (§3.4), protobuf get `src 32→32` (§4.4), `EnergyStreamSwitch`
  96/97 (§4.5), JSON `{"command":"ping"}` on `/app/device/property/<sn>` (shuette42, echo must be
  filtered). shuette42's STREAM/PowerOcean writes are "byte-for-byte replays" of captured app frames —
  a valid fallback technique for new devices: capture with the app-account MQTT subscription
  (`/app/<userId>/<sn>/thing/property/set` shows what the app sends) — no phone MITM needed.
- Certificate pinning in the current app (v6.16): undocumented; nobody needed TLS MITM because the
  app's own MQTT topics can be observed with the account credentials.

---

## 7. Existing code worth copying (all checked 2026-08)

| Project                                                             | Lang / license             | Path                                   | Copy this                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | -------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| foxthefox/ioBroker.ecoflow-mqtt v1.4.9                              | JS, MIT, pushed 2026-08-20 | app-MQTT, PowerStream + all STREAM r/w | login (`lib/ecoflow_utils.js` ~L3320-3415), `pstreamDecode` + XOR (~L337), per-device `lib/dict_data/ef_*_data.js` (proto strings, `deviceStates` units/multipliers/ranges, `deviceCmd`, `protoMsg` dispatch), `lib/helper/protobufhelper.js` (raw dumper), `lib/ha_utils.js` (HA discovery) |
| tolwi/hassio-ecoflow-cloud v1.7.1                                   | Python, Apache-2.0         | both paths                             | proper `.proto` files: `devices/internal/proto/powerstream.proto`, `stream_ac.proto`, `ef_bk_series.proto`, `smartplug.proto`; `api/private_api.py`, `api/public_api.py` (signing + client-id comment)                                                                                       |
| rotflorg/node-red-contrib-ecoflow-powerstream 0.7.3                 | TS, MIT                    | app-MQTT PowerStream                   | smallest clean TS decoder/encoder (`src/protocol.ts`, `decoder.ts`, `encoder.ts`) — lacks XOR + STREAM                                                                                                                                                                                       |
| rustyy/ecoflow-api (`@ecoflow-api/rest-client` 0.6, `/schemas` 0.7) | TS, MIT                    | official HTTP                          | `SignatureBuilder.ts`, zod PowerStream schemas, `getMqttCredentials()`                                                                                                                                                                                                                       |
| PietroLubini/homebridge-ecoflow                                     | TS, MIT                    | official HTTP+MQTT                     | `ecoFlowHttpApiManager.ts`, `ecoFlowMqttApiManager.ts`                                                                                                                                                                                                                                       |
| MichelFR/ha-ecoflow-iot                                             | Python, MIT                | official, MQTT-first                   | keep-alive/fallback state machine, per-device quota docs                                                                                                                                                                                                                                     |
| shuette42/ecoflow-energy-ha                                         | Python, MIT                | app-MQTT (WSS)                         | `enhanced_auth.py` (AES-CFB cert), `energy_stream.py`, `cloud_mqtt.py` (4-tier reconnect), `parsers/stream_proto.py`                                                                                                                                                                         |
| rabits/ha-ef-ble                                                    | Python, Apache-2.0         | BLE                                    | whole `eflib/` if a BLE transport is ever wanted                                                                                                                                                                                                                                             |
| tomvd/local-powerstream, RGarrett93/hassio-ecoflow-mqtt-decoder     | Java / Python              | local broker                           | Mosquitto config + observed device topics/creds                                                                                                                                                                                                                                              |

Name check: `ecoflow2mqtt` is unclaimed on npm and GitHub (2026-08-26). Nobody in Node uses
`@bufbuild/protobuf`; everyone does `protobufjs.parse(protoString)` at runtime (proto3 `optional`
needs protobufjs ≥ 7).

---

## 8. Proposed design for ecoflow2mqtt (on mqtt-interfaces-core)

```
ecoflow2mqtt/
├── index.js              createAdapter + transport wiring
├── config.js             parseConfig: --mode official|app|local, --sn, --region, keys/credentials, --poll
├── lib/
│   ├── install.js
│   ├── hadiscovery.js    pure: items → HA entities (sensor W/V/A/°C/Hz, number permanentWatts, select supplyPriority)
│   ├── items.js          ONE item table: {item, unit, scale, official key, protobuf field, ha class, settable}
│   ├── official/         sign.js (HMAC, with official test vector), http.js, mqtt.js (/open topics, latestQuotas timer)
│   ├── app/              login.js (auth/login + certification, region fallback), mqtt.js (/app topics, get timer, EnergyStream)
│   ├── proto/            header.proto, powerstream.proto, bk_series.proto (vendored from tolwi, Apache-2.0 header kept)
│   │   └── decode.js     HeaderMessage → XOR → dispatch(cmd_func, cmd_id) → normalized {item: value}
│   └── local/            (later) same as app/mqtt.js against own broker, rejectUnauthorized:false
└── test/                 sign vector, decode fixtures (captured base64 frames), item mapping, installer
```

Behaviour:

- `status/pv1_watts`, `pv2_watts`, `pv_watts` (sum), `inv_output_watts`, `bat_watts`, `bat_soc`,
  `grid_watts` (STREAM), volts/amps/temps/freq as diagnostics, `permanent_watts`, `supply_priority`,
  `lower_limit`, `upper_limit`, `feed_protect`, `wifi_rssi`, `online`.
- `set/permanent_watts`, `set/supply_priority`, `set/lower_limit`, `set/upper_limit`, `set/feed_protect`,
  `set/brightness`; STREAM Micro: `set/feed_grid_mode_pow_limit`, `set/inv_target_pwr`.
- Keep-alive: official → `latestQuotas` JSON every 20 s + HTTP `quota/all` if silent 120 s; app →
  protobuf get every 60 s (+ EnergyStreamSwitch every 20 s for `BK` devices) + re-certify on auth error.
- Single MQTT client with a **fixed clientId** (official: derive from `--name`; app: persist the UUID
  in the env file so the `ANDROID_<uuid>_<userId>` id stays stable).
- Device connected state (`<name>/connected` = 2) from heartbeat recency, not from `/status`.
- Log every unknown `(cmd_func, cmd_id)` once with hex so new firmware fields can be added as data.

Suggested order (STREAM Micro): (1) app path with protobuf for the BK series (+ a capture mode that
dumps raw frames as base64 fixtures) → (2) official path if the 1006 test passes → (3) PowerStream
support from the vendored `powerstream.proto` (untestable without a device, keep it data-driven) →
(4) local broker mode once someone proves STREAM devices accept a self-signed broker.

---

## 9. Things to verify on the real device before coding the item table

1. SN prefix (`HW51` vs `BK01/N011`) — decides which decoder and whether the official API is usable.
2. Official API: does `/device/quota/all` return data for your SN, or error 1006? Does `/open/.../quota`
   push, and at what cadence with/without the `latestQuotas` get?
3. Current scaling: `pv1InputCur`/`batInputCur`/`invOutputCur` — 0.1 A (doc) vs mA (tolwi).
4. `ratedPower` scaling (600/800 W model differences).
5. App path: capture 1 min of `/app/device/property/<SN>` as base64 fixtures for the test suite.
6. Whether the device honours `heartbeat_frequency` if set (nobody has documented writing it).

---

## 10. Sources

Official (decoded from `cdn-fe.ecoflow.com/ef-open-platform/static/js/main.*.chunk.js`, copies were in the ephemeral session
scratchpad as `doc_generalInfo.md`, `doc_httpCommon.md`, `doc_mqttCommon.md`, `doc_powerStream_new.md`, `doc_bkw.md`):
https://developer-eu.ecoflow.com/us/document/introduction ·
https://developer-eu.ecoflow.com/us/document/powerStreamMicroInverter · STREAM doc slug `bkw` [uncertain]

Reference implementations: https://github.com/tolwi/hassio-ecoflow-cloud (issues #54, #261, #306, #345,
#351, #453, #484, #540, #541, #594, #701, #704, #745, #782, #798, #830, #881, #902; discussions #88, #344, #414, #731) ·
https://github.com/foxthefox/ioBroker.ecoflow-mqtt (issues #183, #439; `doc/devices/pstream600.md`, `stream_inverter.md`) ·
https://github.com/MichelFR/ha-ecoflow-iot · https://github.com/shuette42/ecoflow-energy-ha ·
https://github.com/rotflorg/node-red-contrib-ecoflow-powerstream · https://github.com/rustyy/ecoflow-api ·
https://github.com/PietroLubini/homebridge-ecoflow · https://github.com/Shaoranlaos/node-red-contrib-ecoflow-http-api ·
https://github.com/klein0r/ioBroker.ecoflow-iot · https://github.com/sirdir1972/iobroker-powerstream-mqtt ·
https://github.com/Waly-de/ioBroker.ecoflow-powercontrol · https://github.com/peuter/ecoflow (no license) ·
https://github.com/tess1o/go-ecoflow · https://github.com/berezhinskiy/ecoflow_exporter ·
https://github.com/energychain/ecoflow_mqtt_credentials · https://energychain.github.io/site_ecoflow_mqtt_credentials/ ·
https://github.com/mmiller7/ecoflow-withoutflow · https://github.com/Netfreak25/EcoFlow_MQTT_Creds ·
https://github.com/TarasKhust/ecoflow-api-mqtt · https://github.com/yourdawi/ha-ecoflow

Local / BLE: https://github.com/rabits/ha-ef-ble · https://github.com/rabits/ef-ble-reverse ·
https://github.com/Just-Zuul/Local-MQTT-EcoFlow-PowerStream-BLE-Bridge · https://github.com/lollokara/ESP32-Ecoflow-BLE ·
https://github.com/Kotsiubynskyi/ef-ble-wrapper · https://gnox.github.io/user_id · https://github.com/tomvd/local-powerstream ·
https://github.com/RGarrett93/hassio-ecoflow-mqtt-decoder · https://github.com/RGarrett93/hassio-ap-ecoflow-dns-redirect ·
https://github.com/v1ckxy/ecoflow-withoutflow · https://www.bussink.net/ecoflow-network/ ·
https://github.com/wwerther/ha-ecotracker-emulator · https://github.com/aaa4xu/ecoflow-app-proto ·
https://github.com/nielsole/ecoflow-bt-reverse-engineering

Forums / write-ups: https://community.openhab.org/t/ecoflow-stream-new-generation/169033 ·
https://www.openhab.org/addons/bindings/ecoflow/ · https://community.home-assistant.io/t/ecoflow-stream-microinverter-support/994535 ·
https://community.home-assistant.io/t/ecoflow-ble-unofficial/774794 · https://community.home-assistant.io/t/ecoflow-api-integration-official-developer-api-mqtt-delta-pro-3/961513 ·
https://forum.iobroker.net/post/964761 · https://forum.iobroker.net/post/964663 ·
https://forum.iobroker.net/topic/69819/neuer-adapter-ecoflow-mqtt/254 · https://forum.iobroker.net/topic/69819/neuer-adapter-ecoflow-mqtt/336 ·
https://forum.iobroker.net/topic/66743/ecoflow-connector-script-zur-dynamischen-leistungsanpassung ·
https://www.photovoltaikforum.com/thread/257136-ecoflow-stream-mit-ecoflow-ble-%C3%BCber-home-assistant/ ·
https://www.photovoltaikforum.com/thread/200570-ecoflow-powerstream-speicher-f%C3%BCr-balkonkraftwerk/?pageNo=557 ·
https://www.photovoltaikforum.com/thread/208943-ecoflow-powerstream-bastelecke-plug-nachbau-zur-messwerte-%C3%BCbergabe-eines-energie/ ·
https://akkudoktor.net/t/ecoflow-stream-ultra-und-ac-pro/29709 · https://pv-balkon.de/home-assistant/ecoflow-integration/ ·
https://www.juergenstechnikwelt.de/photovoltaik/offizielle-ecoflow-api-mittels-fhem-und-mqtt-nutzen/ ·
https://haus-automatisierung.com/hardware/2024/11/06/ecoflow-iot-api.html ·
https://www.tech-blogger.net/ecoflow-public-api-in-python-hmac-signatur-und-client-implementierung/ ·
https://www.diemelstadt-rhoden.de/ecoflow-mqtt-step-by-step/ · https://forum.ecoflow.com/post/1958943566215020546 ·
https://matterdevices.io/tag/ecoflow/ · https://kb.shelly.cloud/knowledge-base/kbuca-ecoflow-works-with-shelly ·
https://shelly-forum.com/thread/30587-kommunikation-zwischen-shelly-pro-3em-und-ecoflow-stream-ac-pro-ohne-internet-ve/
