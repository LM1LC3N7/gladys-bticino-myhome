# CLAUDE.md

Project rules for coding assistants and contributors. Read
`~/code/integrations/CLAUDE.md` and `_lots/fiche.md` first when working from
the integrations workspace.

## What this is

A Gladys Assistant external integration (Node.js 22+, ESM, no build step, one
runtime dependency: `@gladysassistant/integration-sdk`) for BTicino / Legrand
MyHOME through an OpenWebNet gateway on the local network.

## Commands

```bash
npm install
npm test                 # node --test --test-timeout=60000 (every test/*.test.js)
npm run lint
npm run format:check
npm run cover            # cover.png
node scripts/mutants.mjs # mutants of the guards, under memcap
```

From the integrations workspace: `gi test`, `gi ci`.

## Architecture

```
index.js              SDK wiring
src/handlers.js       the SDK handlers (shared with the tests)
src/app.js            lifecycle, reads, commands, protectives, thermostats
src/gateway.js        CommandLink (one session, queues, cut) and EventLink
src/own/session.js    one OpenWebNet session: negotiation, one request at a time
src/own/auth.js       OPEN password (legacy, HMAC), from OWNd
src/own/frames.js     reader, parser, decoder, frames sent, from OWNd
src/devices.js        model -> Gladys devices and states (pure)
src/publisher.js      states under the 300/min limit
src/store.js          /data (bounded, never overwritten when unreadable)
src/config.js, src/constants.js, src/i18n.js
test/helpers/         in-memory gateway, clocks, app setup
```

## Rules

- External ids are forever: `ext:<sel>:light:<A/PL>`, `shutter:<A/PL>`,
  `zone:<n>` (`#` -> `-`); feature keys `binary`, `brightness`, `readonly`,
  `state`, `position`, `temperature`, `target`, `mode`.
- A protective (light off, shutter stop, zone off) is never blocked by an
  option; every change near it needs a test that fails without it
  (`test/stop.test.js`), on the virtual clock.
- Thermostat writes stay off by default, checked at every step.
- The password is never logged, never in /data, never in a status.
- Port only OWNd code from after 2026-09-29 (Apache-2.0).
- Changelog under `## [Unreleased]`; user texts in English and French; docs and
  i18n kept true to the code.
