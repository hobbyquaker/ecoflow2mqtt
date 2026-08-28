# Captured frames (STREAM Microinverter, BK01, EU)

Captured 2026-08-28 from `/app/device/property/<SN>` and the `get_reply` / `set_reply` topics of
the EcoFlow app-account MQTT broker (`mqtt-e.ecoflow.com`), firmware unknown, `product_id 17409`.

Line format: `<seconds since start> <phase A|B|C> <topic> <base64 HeaderMessage>`.
`device_sn` / `module_sn` in every header and the SN in the topic are replaced by `BK01ZXXXXXXXXXXX`,
the user id in topics by `USERID`. `pdata` bytes are untouched (still XOR-obfuscated with `seq & 0xFF`
where `enc_type == 1`).

| file                                 | phases                                                 | notes                                                                                      |
| ------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `stream-micro-run1-app-open.b64`     | A passive 90 s, B get/60 s, C +EnergyStreamSwitch/20 s | EcoFlow app was open: contains foreign `get_reply` (seq 6–8) and `254/18` ConfigWrite acks |
| `stream-micro-run2-app-closed.b64`   | same phases                                            | app closed ~1 min before                                                                   |
| `stream-micro-run3-passive-8min.b64` | A passive 480 s, B get/60 s ×4, C 60 s                 | app closed 10–20 min before; no throttling                                                 |

Full `DisplayPropertyUpload` (254/21) frames have 31 fields; see ROADMAP.md §6 item 3.
