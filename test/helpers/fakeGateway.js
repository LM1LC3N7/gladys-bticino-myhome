// -----------------------------------------------------------------------------
// An in-memory OpenWebNet gateway for the tests: sockets that behave like
// node:net ones (connect, data, close), the greeting, the three password
// methods, the command and event sessions, and an installation (lights,
// dimmers, shutters, heating zones) that answers the requests and reports
// its changes on the event sessions. Faults: offline, silent frames, NACKed
// frames, a refused password, a session closed right after the password, a
// stop that is not applied, another MAC.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { hexToDigits, hmacAnswer, hmacExpected, openPassword } from '../../src/own/auth.js';
import { encodeTemperature, parse } from '../../src/own/frames.js';

export const NONCE = '603356072';
export const RA = '0102030405060708091011121314150001020304';

const tenths = (t) =>
  t < 0 ? `1${String(Math.round(-t * 10)).padStart(3, '0')}` : encodeTemperature(t);

class FakeSocket extends EventEmitter {
  constructor(gateway) {
    super();
    this.gateway = gateway;
    this.destroyed = false;
    this.writableLength = 0;
    this.buffer = '';
    this.state = 'greeting';
    this.session = undefined;
  }

  setNoDelay() {}
  setKeepAlive() {}

  send(text) {
    if (this.destroyed) return;
    const deliver = () => {
      if (!this.destroyed) this.emit('data', Buffer.from(text, 'ascii'));
    };
    if (this.gateway.latency > 0)
      this.gateway.clock.timers.setTimeout(deliver, this.gateway.latency);
    else queueMicrotask(deliver);
  }

  write(data) {
    if (this.destroyed) throw new Error('write after destroy');
    this.buffer += String(data);
    let index;
    while ((index = this.buffer.indexOf('##')) !== -1) {
      const frame = this.buffer.slice(0, index + 2);
      this.buffer = this.buffer.slice(index + 2);
      this.gateway.receive(this, frame);
    }
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.gateway.sockets.delete(this);
    queueMicrotask(() => this.emit('close'));
  }
}

export function createGateway({
  clock,
  auth = 'none',
  password = '',
  mac = [0, 3, 80, 1, 2, 3],
  latency = 0,
  ...faults
} = {}) {
  const gateway = {
    clock,
    auth,
    password,
    mac,
    latency,
    sockets: new Set(),
    connections: 0,
    sessions: { command: 0, event: 0 },
    received: [],
    commands: [],
    offline: false,
    /** Frames (exact, or a prefix ending with `*`) that get no answer at all. */
    silent: new Set(),
    /** Frames (exact) answered NACK. */
    nack: new Set(),
    /** Frames (exact) ACKed but not applied. */
    ignore: new Set(),
    /** No answer at all to a session request (a negotiation that hangs). */
    silentNegotiation: false,
    /** No event pushed on the event sessions (a quiet bus). */
    quiet: false,
    /** Stops (WHO 2 WHAT 0) not applied: the shutter keeps moving. */
    ignoreStop: false,
    /** Closes the session right after the password, before answering. */
    dropAfterPassword: false,
    /** Answers the HMAC with a wrong digest (it does not know the password). */
    impostor: false,
    lights: new Map([
      ['11', { on: false }],
      ['12', { on: true }],
      ['13', { on: false, level: 0, dimmer: true }],
    ]),
    shutters: new Map([
      ['21', { motion: 0 }],
      ['22', { motion: 0, position: 50, advanced: true }],
    ]),
    zones: new Map([[1, { temperature: 19.5, setpoint: 20, mode: 311 }]]),

    connect() {
      const socket = new FakeSocket(gateway);
      gateway.connections += 1;
      queueMicrotask(() => {
        if (gateway.offline) {
          socket.destroyed = true;
          const err = new Error('connect ECONNREFUSED');
          err.code = 'ECONNREFUSED';
          socket.emit('error', err);
          socket.emit('close');
          return;
        }
        gateway.sockets.add(socket);
        // The greeting comes first, whatever the client writes on connect.
        socket.send('*#*1##');
        socket.emit('connect');
      });
      return socket;
    },

    get open() {
      return [...gateway.sockets].filter((s) => !s.destroyed);
    },

    /** A frame on every event session (something happened on the bus). */
    push(frame) {
      if (gateway.quiet) return;
      for (const socket of gateway.sockets) {
        if (socket.session === 'event' && socket.state === 'open') socket.send(frame);
      }
    },

    receive(socket, frame) {
      gateway.received.push(frame);
      if (socket.state !== 'open') {
        negotiate(socket, frame);
        return;
      }
      if (socket.session !== 'command') return;
      gateway.commands.push(frame);
      for (const s of gateway.silent) {
        if (s === frame || (s.endsWith('*') && frame.startsWith(s))) return;
      }
      if (gateway.nack.has(frame)) {
        socket.send('*#*0##');
        return;
      }
      if (gateway.ignore.has(frame)) {
        socket.send('*#*1##');
        return;
      }
      const answer = handle(frame);
      if (answer === undefined) {
        socket.send('*#*0##');
        return;
      }
      socket.send(`${answer.join('')}*#*1##`);
    },
  };

  function negotiate(socket, frame) {
    if (gateway.silentNegotiation) return undefined;
    if (socket.state === 'greeting') {
      if (frame === '*99*0##' || frame === '*99*9##') socket.session = 'command';
      else if (frame === '*99*1##') socket.session = 'event';
      else return socket.send('*#*0##');
      gateway.sessions[socket.session] += 1;
      if (gateway.auth === 'none') {
        socket.state = 'open';
        return socket.send('*#*1##');
      }
      if (gateway.auth === 'nonce') {
        socket.state = 'nonce';
        return socket.send(`*#${NONCE}##`);
      }
      socket.state = 'sha';
      return socket.send(gateway.auth === 'sha1' ? '*98*1##' : '*98*2##');
    }
    if (socket.state === 'nonce') {
      if (gateway.dropAfterPassword) return socket.destroy();
      const ok = frame === `*#${openPassword(gateway.password, NONCE)}##`;
      socket.state = ok ? 'open' : 'refused';
      return socket.send(ok ? '*#*1##' : '*#*0##');
    }
    const algorithm = gateway.auth === 'sha1' ? 'sha1' : 'sha256';
    if (socket.state === 'sha') {
      if (frame !== '*#*1##') return socket.destroy();
      socket.state = 'ra';
      return socket.send(`*#${RA}##`);
    }
    if (socket.state === 'ra') {
      if (gateway.dropAfterPassword) return socket.destroy();
      const match = /^\*#([0-9]+)\*([0-9]+)##$/.exec(frame);
      if (!match || match[2] !== hmacAnswer(algorithm, gateway.password, RA, match[1])) {
        socket.state = 'refused';
        return socket.send('*#*0##');
      }
      socket.state = 'proof';
      const proof = gateway.impostor
        ? hexToDigits('0'.repeat(algorithm === 'sha1' ? 40 : 64))
        : hmacExpected(algorithm, gateway.password, RA, match[1]);
      return socket.send(`*#${proof}##`);
    }
    if (socket.state === 'proof') {
      if (frame === '*#*1##') socket.state = 'open';
      else socket.destroy();
    }
    return undefined;
  }

  const lightFrame = (p, l) => `*1*${l.on ? 1 : 0}*${p}##`;
  const shutterFrame = (p, s) => `*2*${s.motion}*${p}##`;
  const advancedFrame = (p, s) =>
    `*#2*${p}*10*${s.motion === 0 ? 10 : s.motion === 1 ? 11 : 12}*${s.position ?? 255}*0*0##`;

  function setLight(p, on, level) {
    const light = gateway.lights.get(p) ?? { on: false };
    light.on = on;
    if (level !== undefined) light.level = level;
    gateway.lights.set(p, light);
    gateway.push(lightFrame(p, light));
  }

  function setShutter(p, motion, position) {
    const shutter = gateway.shutters.get(p) ?? { motion: 0 };
    if (motion === 0 && gateway.ignoreStop) return;
    shutter.motion = motion;
    if (position !== undefined) shutter.position = position;
    gateway.shutters.set(p, shutter);
    gateway.push(shutterFrame(p, shutter));
  }

  function handle(frame) {
    const m = parse(frame);
    if (frame === '*#13**12##') {
      return gateway.mac ? [`*#13**12*${gateway.mac.join('*')}##`] : undefined;
    }
    if (m.kind === 'request' && m.who === 1 && m.where === '0') {
      return [...gateway.lights].map(([p, l]) => lightFrame(p, l));
    }
    if (m.kind === 'request' && m.who === 2 && m.where === '0') {
      return [...gateway.shutters].map(([p, s]) => shutterFrame(p, s));
    }
    if (m.kind === 'request' && m.who === 1 && gateway.lights.has(m.where)) {
      return [lightFrame(m.where, gateway.lights.get(m.where))];
    }
    if (m.kind === 'request' && m.who === 2 && gateway.shutters.has(m.where)) {
      return [shutterFrame(m.where, gateway.shutters.get(m.where))];
    }
    if (m.kind === 'dimensionRequest' && m.who === 1 && m.dimension === '1') {
      const light = gateway.lights.get(m.where);
      if (!light?.dimmer) return undefined;
      return [`*#1*${m.where}*1*${100 + (light.on ? (light.level ?? 100) : 0)}*0##`];
    }
    if (m.kind === 'dimensionRequest' && m.who === 2 && m.dimension === '10') {
      const shutter = gateway.shutters.get(m.where);
      return shutter?.advanced ? [advancedFrame(m.where, shutter)] : undefined;
    }
    if (m.kind === 'status' && m.who === 1 && gateway.lights.has(m.where)) {
      if (m.what === 0) setLight(m.where, false, 0);
      else if (m.what === 1) setLight(m.where, true);
      else if (m.what >= 2 && m.what <= 10) setLight(m.where, true, m.what * 10);
      else return undefined;
      return [];
    }
    if (m.kind === 'dimensionWrite' && m.who === 1 && m.dimension === '1') {
      const level = Number(m.values[0]) - 100;
      setLight(m.where, level > 0, level);
      return [];
    }
    if (m.kind === 'status' && m.who === 2 && gateway.shutters.has(m.where)) {
      setShutter(m.where, m.what);
      return [];
    }
    if (m.kind === 'dimensionWrite' && m.who === 2 && m.dimension === '11#001') {
      const shutter = gateway.shutters.get(m.where);
      if (!shutter) return undefined;
      const target = Number(m.values[0]);
      setShutter(m.where, target > (shutter.position ?? 0) ? 1 : 2);
      return [];
    }
    if (m.who === 4) {
      const zoneNumber = Number(String(m.where).replace('#', ''));
      const zone = gateway.zones.get(zoneNumber);
      if (!zone) return undefined;
      if (m.kind === 'dimensionRequest' && m.dimension === '0') {
        return [`*#4*${zoneNumber}*0*${tenths(zone.temperature)}##`];
      }
      if (m.kind === 'dimensionRequest' && m.dimension === '14') {
        return [`*#4*${zoneNumber}*14*${tenths(zone.setpoint)}*3##`];
      }
      if (m.kind === 'request') return [`*4*${zone.mode}*${zoneNumber}##`];
      if (m.kind === 'dimensionWrite' && m.dimension === '14') {
        zone.setpoint = Number(m.values[0]) / 10;
        zone.mode = 310;
        gateway.push(`*#4*${zoneNumber}*14*${m.values[0]}*3##`);
        return [];
      }
      if (m.kind === 'status' && [303, 311].includes(m.what)) {
        zone.mode = m.what;
        gateway.push(`*4*${m.what}*${zoneNumber}##`);
        return [];
      }
    }
    return undefined;
  }

  return Object.assign(gateway, faults);
}
