# gladys-bticino-myhome

Gladys Assistant external integration for **BTicino / Legrand MyHOME** installations through an **OpenWebNet**
gateway on the local network (MyHOMEServer1, F454, F455, MH201, MH202...): light points, dimmers, roller
shutters, heating zones.

Unofficial, not affiliated with BTicino or Legrand. It has never been tested with a real installation: written
from the OpenWebNet specification and OWNd, tested against a simulated gateway.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- A light off, a shutter stop and a heating zone off are never blocked by an option; changing a set point is off
  by default.
- One command session at a time; the OPEN password (legacy or HMAC SHA-1/SHA-256) is never logged nor kept.

Part of the code is a JavaScript port of [OWNd](https://github.com/OpenWebNet-HA/OWNd), taken only from after its
relicensing under Apache-2.0 (2026-09-29): see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```bash
npm install
npm test
npm run lint && npm run format:check
node scripts/mutants.mjs   # the mutants of the guards (run it under memcap)
```

Licence: Apache-2.0.
