# TODO

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, docker_image).
- Reference: OWNd (OpenWebNet-HA/OWNd) at `1cb2dc1` (2026-11-10), Apache-2.0
  since commit `072a8d1` (2026-09-29, PR #64 merged that day). Only code after
  the relicensing was read; PyPI still shows the LGPL/GPL of the 0.7.x
  releases and was not used.
- One command session at a time, opened on demand, closed after 20 s idle; one
  request in flight; the event session apart. Protectives first, a silent
  request cut after 1 s for them (and a silent background read for a command).
- Protectives kept in /data from the click until a read shows them applied
  (review r1): no age limit, only answered sends count (3 at most), sent
  before any other request (CommandLink.beforeOrdinary), ack within 3.3 s.
- Protectives: light off (and dimmer 0), shutter stop, heating zone off
  (`*4*303*#Z##`, or `*4*303*Z##` for stand-alone thermostats). Not a
  protective: shutter down (no option gates it anyway; never replayed).
- Sensitive, off by default: the set point (`*#4*#Z*#14*T*3##`, 5 to 40 °C,
  OWNd's bounds) and the automatic mode (`*4*311*#Z##`). Mode "heating" or
  "cooling" refused (no set point to give it).
- Identity: the MAC of the gateway (`*#13**12##`), learnt once, read again on
  every new command session and after the event session drops (review r1);
  nothing but a protective is written before; a gateway that NACKs it is
  "unsupported".
- A refused password: 8-bit salted mark in /data, lifted by a success, the
  button or a new password.
- Full read at most once a minute whatever asks, every 10 minutes otherwise;
  the time of the try in /data before the read.
- No `keywords` / `countries` in the manifest (Gladys 5.3.0 only).
- WHO 4 DIMENSION 22 frames are never built (they crash the thermoregulation
  daemon of the Linux gateways, OWNd's `destructive_frame_error`).

## Unknowns (no hardware)

- The set point mode field: 3 (generic) is sent; some central units may want 1
  (heating) or 2 (cooling) for the season in force.
- Which gateways answer the MAC request on the command session.
- Whether a gateway sends a final ACK after the HMAC exchange (it is ignored).

## Later

- CEN / CEN+ scenario buttons as scene triggers (WHO 15/25).
- Energy (WHO 18), the frost protection mode as a preset, the actuators of the
  zones (valves).
- `keywords` and `countries` once Gladys 5.3.0 is the minimum.
