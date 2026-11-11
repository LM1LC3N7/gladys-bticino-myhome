// -----------------------------------------------------------------------------
// OpenWebNet frames: reading them off a socket, parsing them, building the
// few this integration sends. Ported from OWNd (OpenWebNet-HA/OWNd, Apache-2.0
// since 2026-09-29, see THIRD_PARTY_NOTICES.md): the signalling frames
// (OWNd/message/base.py), the WHO 1 lighting, WHO 2 automation and WHO 4
// heating events and commands (OWNd/message/lighting.py, automation.py,
// heating.py), the point-to-point address rule (is_apl_address), the
// coarse dimmer table (COARSE_PRESET_TO_PERCENT, percent_to_brightness_preset)
// and the WHO 4 temperature field (who4_temperature, encode_temperature).
//
// Changed from OWNd:
// - the reader is bounded: a frame is ASCII `*`, `#` and digits only, at most
//   LIMITS.frameBytes bytes; anything else is dropped up to the next `*`;
// - a value field is read only when it is ASCII digits; out of its published
//   range (a level over 100, a temperature over 99.9) it is unknown, never 0;
// - the WHO 4 mode table is read for Gladys: the automatic WHAT (111, 211,
//   311) and the programs and scenarios (1101..3216) are "auto" (OWNd: heat,
//   cool, auto by the season digit), 102 / 202 / 302 are "protection" (OWNd:
//   off), the manual ones heating / cooling / manual by the season digit;
// - only the frames this integration needs are decoded; a WHO 4 DIMENSION 22
//   frame (it crashes the thermoregulation daemon of the Linux gateways,
//   OWNd's destructive_frame_error) is never built.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

const ALLOWED = new Set([...'0123456789*#'].map((c) => c.charCodeAt(0)));
const STAR = 0x2a;
const HASH = 0x23;

/** Splits the bytes of a session into frames (`*...##`), bounded. */
export class FrameReader {
  constructor({ onFrame, onDrop = () => {} }) {
    this.onFrame = onFrame;
    this.onDrop = onDrop;
    this.buffer = [];
  }

  push(chunk) {
    for (const byte of chunk) {
      if (this.buffer.length === 0) {
        if (byte !== STAR) {
          this.onDrop();
          continue;
        }
        this.buffer.push(byte);
        continue;
      }
      if (!ALLOWED.has(byte)) {
        this.buffer = [];
        this.onDrop();
        continue;
      }
      this.buffer.push(byte);
      const n = this.buffer.length;
      if (byte === HASH && n >= 3 && this.buffer[n - 2] === HASH) {
        const frame = Buffer.from(this.buffer).toString('ascii');
        this.buffer = [];
        this.onFrame(frame);
        continue;
      }
      if (n > LIMITS.frameBytes) {
        this.buffer = [];
        this.onDrop();
      }
    }
  }
}

const DIGITS = /^[0-9]+$/;

/** A value field: ASCII digits only, else undefined (never 0). */
export function digits(text) {
  return typeof text === 'string' && DIGITS.test(text) ? Number(text) : undefined;
}

/**
 * A frame -> { kind, who, what, whatParams, where, dimension, values }.
 * kind: ack, nack, nonce, sha, status (`*WHO*WHAT*WHERE##`), request
 * (`*#WHO*WHERE##`), dimensionRequest, dimension (a reply), dimensionWrite,
 * unknown.
 */
export function parse(frame) {
  if (typeof frame !== 'string' || !frame.endsWith('##') || !frame.startsWith('*')) {
    return { kind: 'unknown', raw: frame };
  }
  if (frame === '*#*1##') return { kind: 'ack', raw: frame };
  if (frame === '*#*0##') return { kind: 'nack', raw: frame };
  let match = /^\*98\*([0-9])##$/.exec(frame);
  if (match) return { kind: 'sha', raw: frame, version: match[1] };
  match = /^\*#([0-9]{4,})##$/.exec(frame);
  if (match) return { kind: 'nonce', raw: frame, nonce: match[1] };
  const body = frame.slice(1, -2);
  const fields = body.split('*');
  if (fields[0].startsWith('#')) {
    const who = digits(fields[0].slice(1));
    if (who === undefined || fields.length < 2) return { kind: 'unknown', raw: frame };
    const where = fields[1];
    if (fields.length === 2) return { kind: 'request', raw: frame, who, where };
    const dim = fields[2];
    if (dim.startsWith('#')) {
      return {
        kind: 'dimensionWrite',
        raw: frame,
        who,
        where,
        dimension: dim.slice(1),
        values: fields.slice(3),
      };
    }
    if (fields.length === 3)
      return { kind: 'dimensionRequest', raw: frame, who, where, dimension: dim };
    return { kind: 'dimension', raw: frame, who, where, dimension: dim, values: fields.slice(3) };
  }
  const who = digits(fields[0]);
  if (who === undefined || fields.length !== 3) return { kind: 'unknown', raw: frame };
  const [what, ...whatParams] = fields[1].split('#');
  return { kind: 'status', raw: frame, who, what: digits(what), whatParams, where: fields[2] };
}

// --- Addresses -----------------------------------------------------------------

/**
 * OWNd's is_apl_address: a point-to-point address (A/PL), 2 or 4 digits.
 * 0 is "general", 1 to 9 an area, 00 and 100 areas too: never a point.
 */
export function isPoint(base) {
  if (!/^[0-9]+$/.test(base)) return false;
  if (base.length === 2) {
    const a = Number(base[0]);
    const pl = Number(base[1]);
    return a === 0 ? pl >= 1 && pl <= 9 : pl >= 1 && pl <= 9;
  }
  if (base.length === 4) {
    const a = Number(base.slice(0, 2));
    const pl = Number(base.slice(2));
    if (a === 0) return pl >= 1 && pl <= 15;
    if (a >= 1 && a <= 9) return pl >= 10 && pl <= 15;
    if (a === 10) return pl >= 1 && pl <= 15;
  }
  return false;
}

/**
 * A light or shutter point as written in the frames: `12`, `0215`, or a point
 * behind a bus interface `12#4#01` (interface 01 to 15). undefined if not one.
 */
export function pointOf(where) {
  const match = /^([0-9]{2,4})(?:#4#([0-9]{2}))?$/.exec(String(where ?? ''));
  if (!match || !isPoint(match[1])) return undefined;
  if (match[2] !== undefined) {
    const iface = Number(match[2]);
    if (iface < 1 || iface > 15) return undefined;
  }
  return match[0];
}

/** A heating zone 1 to 99 from a WHO 4 WHERE (`3`, `#3`, `03`); undefined otherwise. */
export function zoneOf(where) {
  const match = /^#?([0-9]{1,2})$/.exec(String(where ?? ''));
  if (!match) return undefined;
  const zone = Number(match[1]);
  return zone >= 1 && zone <= 99 ? zone : undefined;
}

// --- Values ----------------------------------------------------------------------

/** OWNd's COARSE_PRESET_TO_PERCENT (libqtdevices dimmerLevelTo100). */
const COARSE_TO_PERCENT = new Map([
  [2, 1],
  [3, 10],
  [4, 20],
  [5, 30],
  [6, 40],
  [7, 50],
  [8, 60],
  [9, 75],
  [10, 100],
]);

/** OWNd's percent_to_brightness_preset (libqtdevices dimmer100LevelTo10), level 1 to 100. */
export function coarsePreset(level) {
  if (level <= 4) return 2;
  if (level <= 15) return 3;
  if (level <= 25) return 4;
  if (level <= 35) return 5;
  if (level <= 45) return 6;
  if (level <= 53) return 7;
  if (level <= 67) return 8;
  if (level <= 85) return 9;
  return 10;
}

/** OWNd's who4_temperature: `0215` -> 21.5, `1050` -> -5; undefined if not 4 digits. */
export function temperatureOf(raw) {
  if (typeof raw !== 'string' || !/^[01][0-9]{3}$/.test(raw)) return undefined;
  const magnitude = Number(raw.slice(1)) / 10;
  return raw[0] === '1' && magnitude !== 0 ? -magnitude : magnitude;
}

/** OWNd's encode_temperature, for the set points (always positive here). */
export function encodeTemperature(degrees) {
  const tenths = Math.round(degrees * 10);
  if (!Number.isInteger(tenths) || tenths < 0 || tenths > 999) {
    throw new RangeError(`temperature out of range: ${degrees}`);
  }
  return `0${String(tenths).padStart(3, '0')}`;
}

/**
 * What a frame says about a point or a zone, or undefined:
 * { who: 1, point, on, level?, coarse? } | { who: 2, point, motion, position? }
 * | { who: 4, zone, temperature? | setpoint? | mode? | season? }.
 * motion: 'stopped', 'up', 'down'. mode: 'off', 'protection', 'auto', 'heating',
 * 'cooling', 'manual' (generic, season unknown).
 */
export function decode(message) {
  if (!message || (message.kind !== 'status' && message.kind !== 'dimension')) return undefined;
  if (message.who === 1) return decodeLight(message);
  if (message.who === 2) return decodeShutter(message);
  if (message.who === 4) return decodeHeating(message);
  return undefined;
}

function decodeLight(message) {
  const point = pointOf(message.where);
  if (!point) return undefined;
  if (message.kind === 'status') {
    const what = message.what;
    if (what === 0) return { who: 1, point, on: false, level: 0 };
    if (what === 1) return { who: 1, point, on: true };
    if (COARSE_TO_PERCENT.has(what)) {
      return { who: 1, point, on: true, level: COARSE_TO_PERCENT.get(what), dimmer: true };
    }
    // Timers (11-18), blinking (20-29), steps (30, 31), anomaly (19), motion:
    // no on/off state that can be trusted.
    return undefined;
  }
  if (message.dimension === '1' || message.dimension === '4') {
    const raw = digits(message.values[0]);
    if (raw === undefined || raw < 100 || raw > 200) return undefined;
    const level = raw - 100;
    const speed = digits(message.values[1]);
    return {
      who: 1,
      point,
      on: level > 0,
      level,
      dimmer: true,
      ...(speed !== undefined ? { coarse: speed === 240 } : {}),
    };
  }
  return undefined;
}

function decodeShutter(message) {
  const point = pointOf(message.where);
  if (!point) return undefined;
  if (message.kind === 'status') {
    const motion = { 0: 'stopped', 1: 'up', 2: 'down' }[message.what];
    return motion ? { who: 2, point, motion } : undefined;
  }
  if (message.dimension === '10') {
    const state = digits(message.values[0]);
    const motion =
      state === 10
        ? 'stopped'
        : state === 11 || state === 13
          ? 'up'
          : state === 12 || state === 14
            ? 'down'
            : undefined;
    if (!motion) return undefined;
    const level = digits(message.values[1]);
    return {
      who: 2,
      point,
      motion,
      advanced: true,
      ...(level !== undefined && level <= 100 ? { position: level } : {}),
    };
  }
  return undefined;
}

/** WHO 4 WHAT -> mode, as OWNd's OWNHeatingEvent reads it. */
export function modeOf(what) {
  if (what === undefined) return undefined;
  if ([103, 203, 303].includes(what)) return 'off';
  if ([102, 202, 302].includes(what)) return 'protection';
  const auto =
    [111, 211, 311].includes(what) ||
    (what >= 1101 && what <= 1103) ||
    (what >= 2101 && what <= 2103) ||
    (what >= 3101 && what <= 3116) ||
    (what >= 1201 && what <= 1216) ||
    (what >= 2201 && what <= 2216) ||
    (what >= 3201 && what <= 3216);
  if (auto) return 'auto';
  if ([110, 112, 115].includes(what) || (what >= 13001 && what <= 13255)) return 'heating';
  if ([210, 212, 215].includes(what) || (what >= 23001 && what <= 23255)) return 'cooling';
  if ([310, 312, 315].includes(what) || (what >= 33001 && what <= 33255)) return 'manual';
  return undefined;
}

function decodeHeating(message) {
  const zone = zoneOf(message.where);
  if (zone === undefined) return undefined;
  if (message.kind === 'status') {
    if ((message.what === 0 || message.what === 1) && message.whatParams.length === 0) {
      return { who: 4, zone, season: message.what === 1 ? 'heating' : 'cooling' };
    }
    if (message.whatParams.length > 0) return undefined;
    const mode = modeOf(message.what);
    return mode ? { who: 4, zone, mode } : undefined;
  }
  if (message.dimension === '0') {
    const temperature = temperatureOf(message.values[0]);
    if (temperature === undefined || temperature < -40 || temperature > 80) return undefined;
    // `#3` is the zone through the central unit, not its probe: a measure only from `3`.
    if (String(message.where).startsWith('#')) return undefined;
    return { who: 4, zone, temperature };
  }
  if (message.dimension === '14') {
    const setpoint = temperatureOf(message.values[0]);
    if (setpoint === undefined || setpoint < 0 || setpoint > 50) return undefined;
    return { who: 4, zone, setpoint };
  }
  return undefined;
}

// --- Frames sent -------------------------------------------------------------------

const point = (where) => {
  const p = pointOf(where);
  if (!p) throw new RangeError(`not a point address: ${where}`);
  return p;
};
const zone = (z) => {
  if (!Number.isInteger(z) || z < 1 || z > 99) throw new RangeError(`not a zone: ${z}`);
  return z;
};

export const FRAMES = {
  /** The session requests: commands (OWNd: 0, then 9 when 0 is refused) and events. */
  commandSession: '*99*0##',
  commandSessionAlternate: '*99*9##',
  eventSession: '*99*1##',
  ack: '*#*1##',
  nack: '*#*0##',
  /** The gateway's MAC address (OWNd request_mac_address). */
  mac: '*#13**12##',
  /** Every light point, every shutter: one status each (general requests). */
  allLights: '*#1*0##',
  allShutters: '*#2*0##',
  lightOn: (where) => `*1*1*${point(where)}##`,
  lightOff: (where) => `*1*0*${point(where)}##`,
  lightStatus: (where) => `*#1*${point(where)}##`,
  dimmerLevel: (where) => `*#1*${point(where)}*1##`,
  /** Level 1 to 100 at the last speed used (OWNd set_brightness). */
  dimmerSet: (where, level) => {
    if (!Number.isInteger(level) || level < 1 || level > 100) throw new RangeError('level');
    return `*#1*${point(where)}*#1*${100 + level}*0##`;
  },
  /** A coarse-only dimmer (speed 240): WHAT 2 to 10 (OWNd set_brightness_preset). */
  dimmerPreset: (where, level) => `*1*${coarsePreset(level)}*${point(where)}##`,
  shutterUp: (where) => `*2*1*${point(where)}##`,
  shutterDown: (where) => `*2*2*${point(where)}##`,
  shutterStop: (where) => `*2*0*${point(where)}##`,
  shutterStatus: (where) => `*#2*${point(where)}##`,
  shutterAdvanced: (where) => `*#2*${point(where)}*10##`,
  /** Position 0 (closed) to 100 (open), OWNd set_shutter_level. */
  shutterPosition: (where, level) => {
    if (!Number.isInteger(level) || level < 0 || level > 100) throw new RangeError('position');
    return `*#2*${point(where)}*#11#001*${level}##`;
  },
  zoneTemperature: (z) => `*#4*${zone(z)}*0##`,
  zoneSetpoint: (z) => `*#4*${zone(z)}*14##`,
  zoneStatus: (z) => `*#4*${zone(z)}##`,
  /**
   * OWNd set_mode / set_temperature: through a central unit the zone is `#Z`,
   * a stand-alone thermostat takes the plain `Z`. Automatic (the program of
   * the central unit) only exists through it.
   */
  zoneOff: (z, plant) => `*4*303*${plant === 'standalone' ? zone(z) : `#${zone(z)}`}##`,
  zoneAuto: (z) => `*4*311*#${zone(z)}##`,
  zoneSetpointSet: (z, degrees, plant) =>
    `*#4*${plant === 'standalone' ? zone(z) : `#${zone(z)}`}*#14*${encodeTemperature(degrees)}*3##`,
};
