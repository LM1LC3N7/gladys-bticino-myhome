# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-11-11

### Added

- BTicino / Legrand MyHOME through an OpenWebNet gateway, on the local network:
  light points, dimmers, roller shutters (with their position on the advanced
  ones), heating zones (temperature, set point, mode).
- The OPEN password: legacy numeric, HMAC SHA-1 and SHA-256 with the check of
  the gateway's answer; a refused password is never sent again by itself.
- Light off, shutter stop and heating off never blocked by an option, first in
  line, kept in `/data` from the click until a read shows them applied, sent
  again before any other request.
- Set points and the automatic mode off by default, the zone read just before.

[Unreleased]: https://github.com/LM1LC3N7/gladys-bticino-myhome/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-bticino-myhome/releases/tag/v0.1.1
