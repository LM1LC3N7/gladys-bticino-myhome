// -----------------------------------------------------------------------------
// Real TCP sockets and the real clock sped up: the app reaches the in-memory
// gateway through a local TCP server, the period of the full reads is
// measured, a stop goes through, and nothing is left running after stop().
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MyHomeApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './helpers/clock.js';
import { createGateway } from './helpers/fakeGateway.js';
import { CONFIG, SELECTOR, createdDevices, memoryLogger } from './helpers/app.js';

/** A TCP server in front of the in-memory gateway. */
async function tcpGateway(clock, options) {
  const gateway = createGateway({ clock, ...options });
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    const inner = gateway.connect();
    inner.on('data', (chunk) => socket.writable && socket.write(chunk));
    inner.on('close', () => socket.destroy());
    socket.on('data', (chunk) => {
      try {
        inner.write(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on('close', () => {
      sockets.delete(socket);
      inner.destroy();
    });
    socket.on('error', () => undefined);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    gateway,
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(resolve);
      }),
  };
}

async function start(speed) {
  const clock = realClock({ speed });
  const tcp = await tcpGateway(clock, { auth: 'sha2', password: 'Open1234' });
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...CONFIG, host: '127.0.0.1', port: tcp.port, password: 'Open1234' },
    devices: createdDevices(),
  });
  const app = new MyHomeApp({
    gladys,
    logger: memoryLogger(),
    store: memoryStore(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  const close = async () => {
    await app.stop();
    clock.close();
    await tcp.close();
  };
  return { clock, tcp, gladys, app, close };
}

test('real TCP, real clock x600: a full read every 10 minutes, never sooner', async (t) => {
  const { clock, gladys, app, close } = await start(600);
  t.after(close);
  const spy = spyOn(app, 'fullRead', clock);
  await gladys.connect();
  await app.connected();
  const gaps = await measurePeriod(spy, {
    count: 3,
    period: 10 * 60_000,
    min: 10 * 60_000 * 0.98,
    max: 10 * 60_000 * 2,
  });
  assert.equal(gaps.length, 2);
  assert.equal(gladys.fake.connectionStatus?.connected, true);
});

test('real TCP, real time: a stop and a light on answered within 3.3 s; nothing left after stop()', async (t) => {
  const { clock, tcp, gladys, app, close } = await start(1);
  t.after(close);
  await gladys.connect();
  await app.connected();
  for (let i = 0; i < 200 && gladys.fake.connectionStatus?.connected !== true; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(gladys.fake.connectionStatus?.connected, true);
  for (const [id, key, value, frame] of [
    ['shutter:21', 'state', 0, '*2*0*21##'],
    ['light:11', 'binary', 1, '*1*1*11##'],
  ]) {
    const started = performance.now();
    await app.setValue({}, { external_id: `ext:${SELECTOR}:${id}:${key}` }, value);
    assert.ok(performance.now() - started < 3300);
    assert.ok(tcp.gateway.commands.includes(frame), frame);
  }
  await app.stop();
  const set = clock.timersSet;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(clock.timersSet, set, 'no timer after stop()');
});
