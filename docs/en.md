# BTicino / Legrand MyHOME

This integration connects Gladys to a **BTicino / Legrand MyHOME** installation (SCS bus) through an
**OpenWebNet** IP gateway (MyHOMEServer1, F454, F455, MH201, MH202...), on the local network: light points,
dimmers, roller shutters and heating zones.

> **Unofficial**, not affiliated with BTicino or Legrand. It has **never been tested with a real
> installation**: it was written from the OpenWebNet specification published by BTicino and the OWNd library,
> then tested against a simulated gateway. Feedback is welcome.

## What you need

- An OpenWebNet gateway Gladys can reach (TCP port 20000 by default); give it a fixed address.
- Its **OPEN password** if it asks for one (often `12345` out of the box; changed in MyHOME_Suite). Older
  gateways only take a password of digits; recent ones also take letters (HMAC SHA-1 or SHA-256 challenge).
- Depending on the gateway, the IP address of Gladys must be in the allowed addresses ("IP range") of
  MyHOME_Suite.

## Configuration

- **Address of the gateway** and **port**.
- **OPEN password**: kept by Gladys in its database, never shown again, sent only to the gateway as the answer
  to its challenge, never written in the logs nor in `/data`.
- **Dimmers** (optional): the A/PL addresses of the dimmers, e.g. `13, 0215, 12#4#01`. A dimmer that reports its
  level is recognised by itself.
- **Light points read only** (optional): the actuators that must never be switched from Gladys (a pump, a
  ventilation, a heater on a relay...). A light obeys voice assistants, scenes and "turn everything off": list
  here what must never be switched that way, then delete its old feature in Gladys.
- **Heating zones** (optional): the numbers 1 to 99. A zone that reports its temperature is recognised by itself.
- **Thermostats**: "Central unit" (a 3550 central unit, 99 or 4 zones: the commands go through it) or
  "Stand-alone thermostats".
- **Allow changing the set points from Gladys**: off by default (see "Heating").

An entry of the lists that is not understood is ignored and counted in the status of the integration (it is not
shown again).

## The devices

Click "Scan" in the Discovery tab. The integration reads the installation (the state of every light point and
every shutter, the level of the dimmers, the temperature, set point and mode of the zones) and offers:

- **Light point**: on / off; with the **brightness** on a dimmer. A point read only has a state only.
- **Shutter**: open / close / stop; with the **position** (0 closed to 100 open) on a shutter that reports it
  ("advanced" shutters).
- **Heating zone**: temperature, set point, mode (shown: off, manual heating, manual cooling, automatic; to
  choose: off and automatic).

The id of a device is its OpenWebNet address (`light:12`, `shutter:0215`, `zone:3`; a point behind an interface,
`12#4#01`, is `12-4-01`): it never changes.

The changes made on the installation (buttons, app, program) come through the event session of the gateway. The
whole installation is read again every 10 minutes, never twice within a minute (restart, reconnection and button
included). A value older than 2 hours is not published any more.

## The commands

The integration opens **one command session at a time**, one request at a time. Each command is written within
2.5 s or not at all, then the device is read back: Gladys gets its answer within 3.3 s:

- **confirmed**: the read back shows the value asked;
- **not sent** (nothing left): the gateway does not answer, was busy for too long, too many commands wait, or a
  stop of the same device came after it;
- **refused by the gateway** (NACK): nothing was done;
- **sent, without confirmation**: it left, but the read back does not show the value yet; the device is read
  again 5 s and 20 s later.

Before any command or read on a new session (after a disconnection, or a session closed), the MAC address of the
gateway is read; the events are taken only once the MAC is known: another gateway at the same
address stops the commands until "Test the connection" is clicked.

### The light off, the shutter stop, the heating off

Switching a light off (or a dimmer to 0), stopping a shutter and switching a heating zone off go before
everything else: they depend on no option, no read before, nor on the MAC address read. A read the gateway
leaves unanswered for 1 s is cut for them; the commands of the same device still waiting are cancelled (nothing
asked before a stop leaves after it).

Gladys gets their answer within 3.3 s, whatever the gateway does; the work goes on afterwards. They are **kept
in `/data` from the click**, with the state of the device at that moment, until a read (or an event) shows the
device off or stopped. When they cannot leave, they are tried again every 250 ms for 3.3 s, then sent again
**before any other request** as soon as the gateway answers (after a restart too), with no age limit. Only a
send the gateway answered (ACK or NACK) counts as a try: after 3 answered sends without effect, they are not sent
again. A send left unanswered is kept and sent again. A request that makes a protective wait more than 1.5 s is
cut, even one that still answers.

A stop kept for later is dropped when a newer command of the same device left, or when the device changes on
the installation to another state than the one at the click (a new movement, the other way, a light switched on
again): it never stops a movement started afterwards by someone else. An echo of the same state lifts nothing.
An off or a stop that the read back contradicts (the light still on, the shutter still moving) is sent once more
within the 3.3 s, then by the follow-up reads (5 s, 20 s).

They are refused only in these cases:

- the integration has no address of the gateway yet;
- the OPEN password of the configuration holds characters no gateway takes;
- the connection is stopped: password refused, a gateway that asks for a missing password or only takes digits,
  a gateway that did not prove it knows the password, another gateway at this address (a refused password is
  never sent again by itself);
- the point is read only in the configuration;
- the value asked is not valid;
- the gateway answers NACK to every try for 3.3 s (the order stays kept, 3 answered sends at most).

### Heating

Changing the set point of a zone (5 to 40 °C, by half degrees) or putting it back to **automatic** (the program
of the central unit) is **off by default**. Once allowed, the option is checked again when asked, after the read
of the zone and right before the write; the zone is read just before (when it does not answer, nothing is sent);
a set point equal to the one read is not written again. These commands are refused while the zone is being
switched off. The mode only offers "Off" and "Automatic": to heat, set a set point. A stand-alone thermostat has
no "Automatic".

**Switching a zone off** (mode "Off") never depends on the option (its only refusals are listed above).

## The password

- A refused password stops the connection: no new try until the password changes or "Test the connection" is
  clicked. Two sessions closed by the gateway right after the password count as a refusal. The refusal is kept
  in `/data` as an 8-bit salted mark (never the password): a restart does not send the same password again.
- With the HMAC challenge, the gateway must prove it knows the password; otherwise the connection stops, and
  the same mark keeps a restart from answering it again.
- A gateway that stays silent after the password is not a refusal: it is tried again with the usual waits.

## Status and failures

The status of the integration says "Connected" only when the event session is open and the gateway answered a
read. A gateway that does not answer is tried again after 10 s, 30 s, 1 min, 2 min, then every 5 min. When
`/data` cannot be read, it is never overwritten and it is read again every 10 s.

## Limits

- No scenarios (CEN, WHO 15/25), energy (WHO 18), alarm, locks or gates in v1.
- An "advanced" shutter whose position is unknown has open / close / stop only until it reports its position.
- A gateway has a limited number of sessions: the integration normally keeps two (events and commands); the
  command session is closed after 20 s without a request.

## Source

The code is at <https://github.com/LM1LC3N7/gladys-bticino-myhome> (Apache-2.0). It ports part of OWNd
(OpenWebNet-HA, Apache-2.0 since 2026-09-29) to JavaScript, see `THIRD_PARTY_NOTICES.md`.
