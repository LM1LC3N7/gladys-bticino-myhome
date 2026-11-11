// -----------------------------------------------------------------------------
// The app on the in-memory gateway, virtual clock: start, reads, commands,
// confirmation, Gladys reconnections.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, D, F, MINUTE, SECOND, setup, testClock } from './helpers/app.js';
import { memoryStore } from '../src/store.js';

test('start: event session, full read, connected, fresh states of the created features', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  assert.equal(s.gateway.sessions.event, 1);
  assert.equal(s.status()?.connected, true, JSON.stringify(s.status()));
  assert.match(s.status().message.fr, /3 point\(s\) lumineux, 2 volet\(s\), 1 zone/);
  assert.equal(s.state('light', '12', 'binary'), 1);
  assert.equal(s.state('light', '11', 'binary'), 0);
  assert.equal(s.state('light', '13', 'brightness'), 0);
  assert.equal(s.state('shutter', '21', 'state'), 0);
  assert.equal(s.state('shutter', '22', 'position'), 50);
  assert.equal(s.state('zone', '1', 'temperature'), 19.5);
  assert.equal(s.state('zone', '1', 'target'), 20);
  assert.equal(s.state('zone', '1', 'mode'), 3);
  const discovered = s.gladys.fake.discoveredDevices.map((d) => d.external_id);
  for (const id of [D('light', '11'), D('shutter', '22'), D('zone', '1')]) {
    assert.ok(discovered.includes(id), id);
  }
  assert.equal(s.gladys.fake.transports.at(-1)?.transport, 'local');
});

test('a light on and off: written, read back, confirmed', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  let click = await s.click('light', '11', 'binary', 1);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  assert.equal(s.sent('*1*1*11##'), 1);
  assert.equal(s.state('light', '11', 'binary'), 1);
  click = await s.click('light', '11', 'binary', 0);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  assert.equal(s.sent('*1*0*11##'), 1);
  assert.equal(s.state('light', '11', 'binary'), 0);
});

test('values are strict: null, empty, out of range are refused, nothing sent', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const before = s.gateway.commands.length;
  for (const [kind, id, key, value] of [
    ['light', '11', 'binary', null],
    ['light', '11', 'binary', ''],
    ['light', '11', 'binary', 2],
    ['light', '13', 'brightness', 101],
    ['light', '13', 'brightness', ''],
    ['shutter', '21', 'state', 3],
    ['shutter', '22', 'position', -1],
    ['zone', '1', 'mode', 7],
  ]) {
    const click = await s.click(kind, id, key, value, { wait: 100 });
    assert.equal(click.ack?.success, false, `${kind} ${key} ${value}`);
  }
  assert.equal(s.gateway.commands.length, before);
});

test('a dimmer level, and a coarse-only dimmer gets the coarse steps', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  let click = await s.click('light', '13', 'brightness', 40);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  assert.equal(s.sent('*#1*13*#1*140*0##'), 1);
  assert.equal(s.state('light', '13', 'brightness'), 40);
  // The dimmer says it only takes coarse levels (speed 240).
  s.gateway.push('*#1*13*1*140*240##');
  await s.clock.advance(10);
  click = await s.click('light', '13', 'brightness', 60);
  assert.equal(s.sent('*1*8*13##'), 1);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  // 0 is an off (protective).
  click = await s.click('light', '13', 'brightness', 0);
  assert.equal(s.sent('*1*0*13##'), 1);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
});

test('shutters: up, down, position, stop', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  let click = await s.click('shutter', '21', 'state', 1);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  assert.equal(s.sent('*2*1*21##'), 1);
  assert.equal(s.state('shutter', '21', 'state'), 1);
  click = await s.click('shutter', '21', 'state', 0);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  assert.equal(s.sent('*2*0*21##'), 1);
  assert.equal(s.state('shutter', '21', 'state'), 0);
  await s.click('shutter', '21', 'state', -1);
  assert.equal(s.sent('*2*2*21##'), 1);
  click = await s.click('shutter', '22', 'position', 80);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  assert.equal(s.sent('*#2*22*#11#001*80##'), 1);
});

test('a command the gateway NACKs is refused as such', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.nack.add('*1*1*11##');
  const click = await s.click('light', '11', 'binary', 1);
  assert.equal(click.ack?.success, false);
  assert.match(click.ack.error.message, /NACK/);
});

test('a command written but never answered: "sent, without confirmation" within 3.3 s, read again later', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.silent.add('*1*1*11##');
  const click = await s.click('light', '11', 'binary', 1, { wait: 3400 });
  assert.equal(click.ack?.success, false);
  assert.match(click.ack.error.message, /sans confirmation/);
  s.gateway.silent.clear();
  const reads = s.sent('*#1*11##');
  await s.clock.advance(25 * SECOND);
  assert.ok(s.sent('*#1*11##') >= reads + 2, 'read back at 5 s and 20 s');
});

test('a command that cannot leave by 2.5 s is never written', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  // A command of another light the gateway leaves silent holds the session.
  s.gateway.silent.add('*1*1*12##');
  const first = await s.click('light', '12', 'binary', 1, { wait: 0 });
  const click = await s.click('light', '11', 'binary', 1, { wait: 3400 });
  assert.equal(click.ack?.success, false);
  assert.match(click.ack.error.message, /Non envoyée/);
  await s.clock.advance(10 * SECOND);
  await first.pending;
  assert.equal(s.sent('*1*1*11##'), 0);
});

test('a command cuts a background read the gateway leaves silent', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.silent.add('*#4*1*0##');
  s.app.lastFullRead = undefined;
  s.app.memory.lastReadAt = 0;
  const reading = s.app.fullRead();
  await s.clock.advance(3 * SECOND);
  const click = await s.click('light', '11', 'binary', 1, { wait: 3000 });
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  await s.clock.advance(10 * SECOND);
  await reading;
});

test('the event session reports changes on the installation', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.push('*1*1*11##*2*2*21##*#4*1*0*0225##');
  await s.clock.advance(10);
  assert.equal(s.state('light', '11', 'binary'), 1);
  assert.equal(s.state('shutter', '21', 'state'), -1);
  assert.equal(s.state('zone', '1', 'temperature'), 22.5);
  // A new point seen on the bus joins the Discovery.
  s.gateway.push('*1*1*15##');
  await s.clock.advance(10);
  assert.ok(s.gladys.fake.discoveredDevices.some((d) => d.external_id === D('light', '15')));
});

test('garbage on the event session stops nothing', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.push(`hello*1*x*11##${'*1'.repeat(400)}##*#4*1*0*9999##*1*1*11##`);
  await s.clock.advance(10);
  assert.equal(s.state('light', '11', 'binary'), 1);
  assert.equal(s.state('zone', '1', 'temperature'), 19.5);
  assert.equal(s.status().connected, true);
});

test('the event session lost: unreachable, reconnected after 10 s, read again', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.offline = true;
  for (const socket of s.gateway.open) socket.destroy();
  await s.clock.advance(10);
  assert.equal(s.status().connected, false);
  assert.match(s.status().message.fr, /ne répond pas/);
  assert.equal(s.gladys.fake.transports.at(-1)?.transport, 'unreachable');
  s.gateway.offline = false;
  await s.clock.advance(11 * SECOND);
  await s.clock.advance(MINUTE);
  assert.equal(s.gateway.sessions.event, 2);
  assert.equal(s.status().connected, true);
  assert.equal(s.gladys.fake.transports.at(-1)?.transport, 'local');
});

test('full reads: every 10 minutes, never twice within a minute', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const reads = () => s.sent('*#1*0##');
  assert.equal(reads(), 1);
  await s.app.scan();
  assert.equal(reads(), 1, 'Scan within the gap: no new read');
  await s.clock.advance(10 * MINUTE + SECOND);
  assert.equal(reads(), 2);
});

test('a restart does not read again sooner than the gap (time in /data)', async (t) => {
  const store = memoryStore();
  const s = await setup({ store });
  await s.app.stop();
  assert.ok(store.data.lastReadAt > 0);
  const s2 = await setup({
    store,
    clock: testClock({ start: Date.UTC(2026, 0, 1) + 20 * SECOND }),
  });
  t.after(() => s2.app.stop());
  assert.equal(s2.sent('*#1*0##'), 0);
  await s2.clock.advance(MINUTE);
  assert.equal(s2.sent('*#1*0##'), 1);
});

test('Gladys reconnects: status, devices, states published again', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const devices = s.gladys.fake.discoveredDevices.length;
  await s.app.connected();
  assert.equal(s.status().connected, true);
  assert.equal(s.gladys.fake.discoveredDevices.length, devices);
  assert.equal(s.gateway.sessions.event, 1, 'no new session');
});

test('getConfig failing in connected: retried every 30 s, then started', async (t) => {
  const s = await setup({ getConfigFails: 2 });
  t.after(() => s.app.stop());
  assert.equal(s.status().connected, false);
  assert.match(s.status().message.en, /configuration could not be read/);
  assert.equal(s.gateway.connections, 0);
  await s.clock.advance(30 * SECOND);
  assert.equal(s.gateway.connections, 0);
  await s.clock.advance(30 * SECOND);
  await s.clock.advance(100);
  assert.equal(s.status().connected, true);
});

test('getConfig failing on a Gladys reconnection: retried, the running links kept', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.control.getConfigFails = 1;
  await s.app.connected();
  assert.match(s.status().message.en, /configuration could not be read/);
  await s.clock.advance(30 * SECOND + 100);
  assert.equal(s.status().connected, true);
  assert.equal(s.gateway.sessions.event, 1);
});

test('no address: said in the status, no connection', async (t) => {
  const s = await setup({ config: { ...CONFIG, host: '' } });
  t.after(() => s.app.stop());
  assert.match(s.status().message.en, /address of the OpenWebNet gateway/);
  assert.equal(s.gateway.connections, 0);
});

test('a configuration change applies at once; a new address reconnects', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.app.configUpdated({ ...CONFIG, read_only: '12' });
  const light = s.gladys.fake.discoveredDevices.find((d) => d.external_id === D('light', '12'));
  assert.deepEqual(
    light.features.map((f) => f.external_id),
    [F('light', '12', 'readonly'), F('light', '12', 'binary')],
  );
  const click = await s.click('light', '12', 'binary', 0);
  assert.equal(click.ack?.success, false);
  assert.equal(s.sent('*1*0*12##'), 0);
  assert.equal(s.gateway.sessions.event, 1);
  await s.app.configUpdated({ ...CONFIG, host: '192.168.1.36' });
  await s.clock.advance(100);
  assert.equal(s.gateway.sessions.event, 2);
});

test('nothing stale is published again: 2 hours without the gateway, a device created', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.offline = true;
  for (const socket of s.gateway.open) socket.destroy();
  await s.clock.advance(2 * 60 * MINUTE + MINUTE);
  const before = s.gladys.fake.states.length;
  await s.app.deviceChanged({ external_id: D('light', '12') });
  await s.app.connected();
  await s.clock.advance(MINUTE);
  const after = s.gladys.fake.states.slice(before);
  assert.equal(after.length, 0, JSON.stringify(after));
});

test('a device created by the user gets its fresh states at once', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const before = s.gladys.fake.states.length;
  await s.app.deviceChanged({ external_id: D('light', '12') });
  const sent = s.gladys.fake.states.slice(before).map((e) => e.device_feature_external_id);
  assert.ok(sent.includes(F('light', '12', 'binary')));
});

test('an answer of more than 256 frames is cut, the session closed', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  for (let i = 1; i <= 9; i += 1) {
    for (let j = 1; j <= 9; j += 1) s.gateway.lights.set(`${i}${j}`, { on: false });
  }
  for (let a = 1; a <= 9; a += 1) {
    for (let p = 10; p <= 15; p += 1) s.gateway.lights.set(`0${a}${p}`, { on: false });
  }
  for (let p = 1; p <= 15; p += 1) {
    s.gateway.lights.set(`00${String(p).padStart(2, '0')}`, { on: false });
    s.gateway.lights.set(`10${String(p).padStart(2, '0')}`, { on: false });
    s.gateway.lights.set(`${String(p).padStart(2, '0')}#4#01`, { on: false });
  }
  for (let i = 1; i <= 9; i += 1) {
    for (let j = 1; j <= 9; j += 1) s.gateway.lights.set(`${i}${j}#4#02`, { on: false });
  }
  assert.ok(s.gateway.lights.size > 256);
  const result = await s.app.read('*#1*0##');
  assert.equal(result.error?.kind, 'protocol');
  assert.equal(s.app.model.lightPoints.size, 3, 'nothing taken from a cut answer');
});

test('modes of the zone as the gateway reports them', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  for (const [frame, mode] of [
    ['*4*303*1##', 0],
    ['*4*102*1##', 0],
    ['*4*110*1##', 1],
    ['*4*210*1##', 2],
    ['*4*1101*#1##', 3],
  ]) {
    s.gateway.push(frame);
    await s.clock.advance(10);
    assert.equal(s.state('zone', '1', 'mode'), mode, frame);
  }
});

test('ACKed but not applied: "sent, without confirmation", never confirmed', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.ignore.add('*1*1*11##');
  const click = await s.click('light', '11', 'binary', 1);
  assert.equal(click.ack?.success, false);
  assert.match(click.ack.error.message, /sans confirmation/);
});

test('a session that cannot be opened in time: "not sent" at 3.3 s, never written', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.silentNegotiation = true;
  for (const socket of s.gateway.open) if (socket.session === 'command') socket.destroy();
  await s.clock.advance(10);
  const click = await s.click('light', '11', 'binary', 1, { wait: 3400 });
  assert.equal(click.ack?.success, false);
  assert.match(click.ack.error.message, /Non envoyée/);
  await s.clock.advance(20 * SECOND);
  assert.equal(s.sent('*1*1*11##'), 0);
});

test('too many commands waiting: refused at once, nothing sent for them', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.silentNegotiation = true;
  for (const socket of s.gateway.open) if (socket.session === 'command') socket.destroy();
  await s.clock.advance(10);
  const clicks = [];
  for (let i = 1; i <= 9; i += 1) {
    for (const j of [1, 2, 3, 4, 5]) {
      clicks.push(await s.click('light', `${i}${j}`, 'binary', 1, { wait: 0 }));
    }
  }
  await s.clock.advance(100);
  const full = clicks.filter((c) => /trop de commandes/.test(c.ack?.error?.message ?? ''));
  assert.ok(full.length >= 10, `${full.length} refused for the queue`);
  await s.clock.advance(20 * SECOND);
});
