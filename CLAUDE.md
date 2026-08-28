@AGENTS.md

## Project docs

- ROADMAP.md — implementation spec (§2, §3), decisions E-1…E-9, milestones, open questions.
- RESEARCH.md — protocol research; "R §x" references in the code point there.
- The sibling repos under `../` are the reference: `mqtt-interfaces-core` (the core library and its
  README, the complete adapter guide), `wiim2mqtt` / `lgtv2mqtt` / `cul2mqtt` (style, tests,
  installer, roadmap layout).

## Live testing

Credentials are in `.local.env` (git-ignored): `ECOFLOW_EMAIL`, `ECOFLOW_PASSWORD`, `ECOFLOW_SN`,
`ECOFLOW_REGION`. Read them, never print them. The device is cloud-connected, so a live run needs
no LAN access to it.
