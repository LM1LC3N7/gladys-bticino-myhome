// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, the in-memory gateway and a virtual
// clock.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MyHomeApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { buildDevices } from '../../src/devices.js';
import { memoryStore } from '../../src/store.js';
import { settle, testClock } from './clock.js';
import { createGateway } from './fakeGateway.js';

export const SELECTOR = 'bticino-myhome';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const CONFIG = {
  host: '192.168.1.35',
  port: 20000,
  dimmers: '13',
  zones: '1',
  language: 'fr',
};
export const SECRET = 'S3cretOpen99';

/** A logger that keeps every line (to look for a secret). */
export function memoryLogger() {
  const lines = [];
  const add =
    (level) =>
    (...args) =>
      lines.push(
        `${level} ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`,
      );
  return { lines, debug: add('debug'), info: add('info'), warn: add('warn'), error: add('error') };
}

export const F = (kind, id, key) => `ext:${SELECTOR}:${kind}:${id}:${key}`;
export const D = (kind, id) => `ext:${SELECTOR}:${kind}:${id}`;

/** Every device a full installation gives, as the user created it from the Discovery. */
export function createdDevices(config = CONFIG) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const model = {
    lightPoints: new Set(['11', '12', '13']),
    shutterPoints: new Set(['21', '22']),
    zoneNumbers: new Set([1]),
    dimmers: new Set(['13']),
    coarse: new Set(),
    advanced: new Set(['22']),
  };
  const normalized = {
    readOnly: [],
    plant: 'central',
    language: config.language ?? 'fr',
  };
  return buildDevices(gladys, normalized, model, []);
}

/**
 * A started app (Gladys connected, the event session up, the first full read
 * done). `start: false` leaves Gladys unconnected.
 */
export async function setup({
  config = CONFIG,
  devices = createdDevices(config),
  store = memoryStore(),
  gateway: options = {},
  clock = testClock(),
  logger = memoryLogger(),
  start = true,
  getConfigFails = 0,
} = {}) {
  const gateway = createGateway({ clock, ...options });
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  // The app's own getConfig() calls can fail (the SDK's resync is untouched).
  const control = { getConfigFails };
  const seen = new Proxy(gladys, {
    get(target, key) {
      if (key === 'getConfig') {
        return async () => {
          if (control.getConfigFails > 0) {
            control.getConfigFails -= 1;
            throw new Error('Gladys is busy');
          }
          return target.getConfig();
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const app = new MyHomeApp({
    gladys: seen,
    logger,
    store,
    connect: gateway.connect,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  registerHandlers(gladys, app, logger);
  if (start) {
    await gladys.connect();
    await settle(20);
    await clock.advance(10);
    await settle(20);
    await clock.advance(10);
  }
  const t = {
    app,
    gladys,
    gateway,
    clock,
    store,
    logger,
    control,
    /** setValue as Gladys does it; the ack read after `wait` virtual ms. */
    async click(kind, id, key, value, { wait = 4000 } = {}) {
      const feature = { external_id: F(kind, id, key) };
      const device = { external_id: D(kind, id) };
      let ack;
      const pending = app.setValue(device, feature, value).then(
        () => (ack = { success: true }),
        (err) => (ack = { success: false, error: err }),
      );
      await settle(10);
      if (wait > 0) await clock.advance(wait);
      await settle(10);
      return {
        pending,
        get ack() {
          return ack;
        },
      };
    },
    status() {
      return gladys.fake.connectionStatus;
    },
    state(kind, id, key) {
      return gladys.fake.lastState(F(kind, id, key));
    },
    sent(frame) {
      return gateway.commands.filter((f) => f === frame).length;
    },
  };
  return t;
}

export { settle, testClock };
