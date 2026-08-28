# Agent instructions — ecoflow2mqtt

## What this is

ecoflow2mqtt is an MQTT interface ("bridge"/"adapter") for EcoFlow micro-inverters — today the
**STREAM Microinverter** (BK01/BK02/N011), later PowerStream (HW51). It talks to EcoFlow's cloud
MQTT broker with the credentials of the owner's **app account** (the unofficial API the app uses,
protobuf with a one-byte XOR), and to the user's own broker, publishing state and announcing the
device to Home Assistant.

It is one of many `xyz2mqtt` adapters by the same author (lgtv2mqtt, wiim2mqtt, cul2mqtt, …). All
follow the [mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) architecture and are
built on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core)
(`../mqtt-interfaces-core` when checked out next to this repo — generic fixes go there; its README
is the complete guide to building an adapter). Consistency with the core's conventions and with
the sibling adapters is a hard requirement.

- **ROADMAP.md** — the implementation spec (§2 mechanism, §3 files/options/rules), decisions
  (E-1…E-9), milestones and open questions. Read it before changing behaviour.
- **RESEARCH.md** — the protocol research (paths, endpoints, protobuf field numbers, sources).
  References like "R §4.5" in the code point there.

## Privacy rules (decision E-2, non-negotiable)

- The author's serial number, account e-mail, password and the account's 19-digit user id **never**
  enter the repository — not in docs, tests, fixtures or examples. Use `BK01ZXXXXXXXXXXX`,
  `me@example.com`, `1000000000000000001`.
- Credentials for local testing live in `.local.env` (git-ignored). Never print their values.
- Logs mask the serial at info level (`lib/mask.js`), full only at `debug`. EcoFlow's default
  `deviceName` embeds the serial's last digits — never publish or log it.
- `--capture` scrubs the serial and the account id itself; `test/capture.test.js` guards that.
  Anything added to `test/fixtures/` must come out of that path.

## Code layout (ES modules, node >= 20.19)

- `index.js` — wiring: `createAdapter()` + `EcoflowClient` frames → `items.update()` → `pubStatus`.
- `config.js` — the adapter's options; `parse()` is exported for tests.
- `lib/app/login.js` — login + certification, region → host table, `EcoflowApiError`. An outage and
  a wrong password look identical here (R §4.1) — never discard credentials because of an error.
- `lib/app/mqtt.js` — the cloud client: client id, subscriptions, `--poll` refresh, reconnect,
  re-authentication, backoff. Emits `frames` and `raw`.
- `lib/proto/` — vendored `.proto` files (data, not code: a new firmware field is a line there),
  `decode.js` (envelope → XOR → dispatch), `encode.js` (the two frames we send).
- `lib/items.js` — the item table and the computed PV total.
- `lib/capture.js`, `lib/clientid.js`, `lib/mask.js`, `lib/hadiscovery.js`, `lib/install.js`.

## Tests

`npm test` (node:test, no framework). The decoder is tested against real captures in
`test/fixtures/*.b64` — keep those tests fixture-driven when adding fields. `npm run lint` runs
eslint + prettier (4 spaces, single quotes, no bracket spacing, width 120).

Live tests need a device: credentials from `.local.env`, e.g.
`node index.js -u mqtt://<broker> -v debug`. Do not point tests at the production broker without
saying so.
