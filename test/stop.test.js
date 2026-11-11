// -----------------------------------------------------------------------------
// Protectives (light off, shutter stop, heating zone off): first in line,
// never blocked, kept in /data when the gateway does not answer.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, MINUTE, SECOND, setup, testClock } from './helpers/app.js';
import { memoryStore } from '../src/store.js';

test('a stop cuts a read the gateway leaves silent, and goes first', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.silent.add('*#4*1*0##');
  s.app.lastFullRead = undefined;
  s.app.memory.lastReadAt = 0;
  const reading = s.app.fullRead();
  await s.clock.advance(3 * SECOND);
  const click = await s.click('shutter', '21', 'state', 0, { wait: 2000 });
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  assert.equal(s.sent('*2*0*21##'), 1);
  await s.clock.advance(10 * SECOND);
  await reading;
});

test('a stop cancels the commands of the same shutter still waiting', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  // Light 12 holds the session (silent), shutter 21 up waits behind it.
  s.gateway.silent.add('*1*1*12##');
  const hold = await s.click('light', '12', 'binary', 1, { wait: 0 });
  const up = await s.click('shutter', '21', 'state', 1, { wait: 0 });
  const stop = await s.click('shutter', '21', 'state', 0, { wait: 4000 });
  await up.pending;
  await hold.pending;
  assert.equal(up.ack?.success, false);
  assert.match(up.ack.error.message, /arrêt ou une extinction/);
  assert.equal(s.sent('*2*1*21##'), 0, 'the up never leaves after the stop');
  assert.equal(s.sent('*2*0*21##'), 1);
  assert.equal(stop.ack?.success, true, stop.ack?.error?.message);
});

test('a stop the shutter does not apply: sent once more at once, then by the read backs, 3 answered sends at most', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.click('shutter', '21', 'state', 1);
  s.gateway.ignoreStop = true;
  const click = await s.click('shutter', '21', 'state', 0);
  assert.equal(s.sent('*2*0*21##'), 2);
  assert.equal(click.ack?.success, false);
  assert.match(click.ack.error.message, /sans confirmation/);
  assert.equal(s.app.memory.pending.length, 1, 'kept until a read shows it applied');
  await s.clock.advance(MINUTE);
  assert.equal(s.sent('*2*0*21##'), 3);
  assert.equal(s.app.memory.pending.length, 0, 'answered 3 times: no more sends');
  await s.clock.advance(MINUTE);
  assert.equal(s.sent('*2*0*21##'), 3);
});

test('a stop applied later is dropped by the read that shows it', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.click('shutter', '21', 'state', 1);
  s.gateway.ignoreStop = true;
  await s.click('shutter', '21', 'state', 0);
  assert.equal(s.app.memory.pending.length, 1);
  s.gateway.ignoreStop = false;
  await s.clock.advance(MINUTE);
  assert.equal(s.app.memory.pending.length, 0);
  assert.equal(s.gateway.shutters.get('21').motion, 0);
});

test('a stop written without ACK nor NACK stays kept and is sent again; the ack comes within 3.3 s', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.click('shutter', '21', 'state', 1);
  s.gateway.silent.add('*2*0*21##');
  const click = await s.click('shutter', '21', 'state', 0, { wait: 3300 });
  assert.equal(click.ack?.success, false, 'acked by 3.3 s');
  assert.match(click.ack.error.message, /sans confirmation/);
  assert.equal(s.app.memory.pending.length, 1);
  s.gateway.silent.clear();
  await s.clock.advance(MINUTE);
  assert.ok(s.sent('*2*0*21##') >= 2);
  assert.equal(s.gateway.shutters.get('21').motion, 0);
  assert.equal(s.app.memory.pending.length, 0);
});

test('a request that trickles past 1.5 s is cut for a stop: acked within 3.3 s', async (t) => {
  const s = await setup({ gateway: { latency: 400 } });
  t.after(() => s.app.stop());
  // Each frame of the general light status comes 400 ms after the previous one.
  for (let p = 31; p <= 39; p += 1) s.gateway.lights.set(String(p), { on: false });
  s.gateway.trickle = 400;
  s.app.lastFullRead = undefined;
  s.app.memory.lastReadAt = 0;
  const reading = s.app.fullRead();
  for (let i = 0; i < 100 && s.sent('*#1*0##') === 0; i += 1) await s.clock.advance(100);
  await s.clock.advance(500);
  const asked = s.clock.elapsed;
  let writtenAt;
  const receive = s.gateway.receive;
  s.gateway.receive = (socket, frame) => {
    if (frame === '*2*0*21##' && writtenAt === undefined) writtenAt = s.clock.elapsed;
    return receive(socket, frame);
  };
  const click = await s.click('shutter', '21', 'state', 0, { wait: 3300 });
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  assert.ok(
    writtenAt !== undefined && writtenAt - asked < 2500,
    `written ${writtenAt - asked} ms after`,
  );
  s.gateway.trickle = 0;
  await s.clock.advance(20 * SECOND);
  await reading;
});

test('off, stop and heating off are never blocked by the thermostat option nor the identity', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  // The MAC cannot be read now: a light on would wait for it, an off never.
  s.app.identity = 'unknown';
  s.gateway.silent.add('*#13**12##');
  for (const [kind, id, key, value, frame] of [
    ['light', '12', 'binary', 0, '*1*0*12##'],
    ['light', '13', 'brightness', 0, '*1*0*13##'],
    ['shutter', '22', 'state', 0, '*2*0*22##'],
    ['zone', '1', 'mode', 0, '*4*303*#1##'],
  ]) {
    const click = await s.click(kind, id, key, value);
    assert.equal(click.ack?.success, true, `${frame}: ${click.ack?.error?.message}`);
    assert.equal(s.sent(frame), 1, frame);
  }
  assert.equal(s.state('zone', '1', 'mode'), 0);
});

test('heating off of a stand-alone thermostat: the plain zone', async (t) => {
  const s = await setup({ config: { ...CONFIG, heating_plant: 'standalone' } });
  t.after(() => s.app.stop());
  const click = await s.click('zone', '1', 'mode', 0);
  assert.equal(s.sent('*4*303*1##'), 1);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
});

test('gateway gone: the stop is tried every 250 ms within 3.3 s, kept in /data, sent when it answers', async (t) => {
  const store = memoryStore();
  const s = await setup({ store });
  t.after(() => s.app.stop());
  s.gateway.offline = true;
  for (const socket of s.gateway.open) socket.destroy();
  await s.clock.advance(10);
  const before = s.gateway.connections;
  const click = await s.click('shutter', '21', 'state', 0, { wait: 3500 });
  assert.equal(click.ack?.success, false);
  assert.match(click.ack.error.message, /gardée et envoyée/);
  assert.ok(s.gateway.connections - before >= 5, `tries: ${s.gateway.connections - before}`);
  assert.equal(store.data.pending.length, 1);
  assert.equal(store.data.pending[0].frame, '*2*0*21##');
  s.gateway.offline = false;
  await s.clock.advance(MINUTE);
  assert.equal(s.sent('*2*0*21##'), 1);
  assert.equal(store.data.pending.length, 0);
});

test('a stop kept in /data is sent after a restart, before the first read', async (t) => {
  const store = memoryStore();
  const s = await setup({ store });
  s.gateway.offline = true;
  for (const socket of s.gateway.open) socket.destroy();
  await s.clock.advance(10);
  await s.click('shutter', '21', 'state', 0, { wait: 3500 });
  await s.app.stop();
  assert.equal(store.data.pending.length, 1);
  const s2 = await setup({
    store,
    clock: testClock({ start: Date.UTC(2026, 0, 1) + 10 * SECOND }),
  });
  t.after(() => s2.app.stop());
  const first = s2.gateway.commands.findIndex((f) => f === '*2*0*21##');
  const read = s2.gateway.commands.findIndex((f) => f === '*#1*0##');
  assert.ok(first >= 0, 'sent');
  assert.ok(read === -1 || first < read, 'before the read');
  assert.equal(store.data.pending.length, 0);
});

test('a stop kept for later is dropped by a newer command that left, or a new movement on the bus', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  // The kept stop is NACKed (sent before the up, kept), then the up leaves: dropped.
  s.gateway.nack.add('*2*0*21##');
  s.app.memory.pending.push({
    kind: 'shutterStop',
    target: 'shutter:21',
    frame: '*2*0*21##',
    at: s.clock.now(),
    tries: 0,
    state: 'down',
  });
  s.gateway.quiet = true;
  await s.click('shutter', '21', 'state', 1);
  assert.equal(s.app.memory.pending.length, 0, 'the up left: the stop is not sent again');
  assert.ok(s.sent('*2*0*21##') >= 1, 'the kept stop went first');
  s.gateway.quiet = false;
  s.gateway.nack.clear();
  s.app.memory.pending.push({
    kind: 'shutterStop',
    target: 'shutter:22',
    frame: '*2*0*22##',
    at: s.clock.now(),
    tries: 0,
    state: 'down',
  });
  s.gateway.push('*2*1*22##');
  await s.clock.advance(10);
  assert.equal(
    s.app.memory.pending.length,
    0,
    'moved the other way on the bus: never stopped behind the user',
  );
  assert.equal(s.sent('*2*0*22##'), 0);
});

test('an echo of the state seen at the click lifts nothing: the stop leaves when the gateway takes it', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.click('shutter', '21', 'state', 1);
  s.gateway.silentNegotiation = true;
  for (const socket of s.gateway.open) if (socket.session === 'command') socket.destroy();
  await s.clock.advance(10);
  const click = await s.click('shutter', '21', 'state', 0, { wait: 3300 });
  assert.equal(click.ack?.success, false);
  assert.equal(s.app.memory.pending[0]?.state, 'up');
  s.gateway.push('*2*1*21##');
  await s.clock.advance(10);
  assert.equal(s.app.memory.pending.length, 1, 'the same state: kept');
  s.gateway.silentNegotiation = false;
  await s.clock.advance(MINUTE);
  assert.equal(s.sent('*2*0*21##'), 1);
  assert.equal(s.app.memory.pending.length, 0);
});

test('a kept stop: only answered sends count (3 at most), no age limit', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.nack.add('*2*0*21##');
  s.app.memory.pending.push({
    kind: 'shutterStop',
    target: 'shutter:21',
    frame: '*2*0*21##',
    at: s.clock.now() - 60 * MINUTE,
    tries: 0,
  });
  for (let i = 0; i < 6; i += 1) {
    await s.app.flushPending();
    await s.clock.advance(10);
  }
  assert.equal(s.sent('*2*0*21##'), 3, 'an hour old, still sent; 3 NACKs, then no more');
  // The gateway gone: no try counted, never abandoned.
  s.gateway.nack.clear();
  s.app.memory.pending = [
    { kind: 'lightOff', target: 'light:12', frame: '*1*0*12##', at: s.clock.now(), tries: 0 },
  ];
  s.gateway.offline = true;
  for (const socket of s.gateway.open) socket.destroy();
  await s.clock.advance(10 * MINUTE);
  assert.equal(s.app.memory.pending.length, 1);
  assert.equal(s.app.memory.pending[0].tries, 0);
  s.gateway.offline = false;
  await s.clock.advance(6 * MINUTE);
  assert.equal(s.sent('*1*0*12##'), 1);
  assert.equal(s.app.memory.pending.length, 0);
});

test('/data that hangs never delays a stop', async (t) => {
  const store = memoryStore();
  const s = await setup({ store });
  t.after(() => s.app.stop());
  store.hang = true;
  const click = await s.click('shutter', '21', 'state', 0, { wait: 1000 });
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  store.hang = false;
});

test('a scene on 5 slow targets: all 5 set', async (t) => {
  const s = await setup({ gateway: { latency: 150 } });
  t.after(() => s.app.stop());
  for (const p of ['14', '15', '16']) s.gateway.lights.set(p, { on: false });
  const clicks = [];
  for (const p of ['11', '14', '15', '16'])
    clicks.push(await s.click('light', p, 'binary', 1, { wait: 0 }));
  clicks.push(await s.click('shutter', '21', 'state', 0, { wait: 0 }));
  await s.clock.advance(5 * SECOND);
  for (const p of ['11', '14', '15', '16']) assert.equal(s.gateway.lights.get(p).on, true, p);
  assert.equal(s.sent('*2*0*21##'), 1);
});

test('a stop written without answer while the shutter looked stopped: an echo "stopped" lifts nothing, a read does', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.silent.add('*2*0*21##');
  await s.click('shutter', '21', 'state', 0, { wait: 3300 });
  assert.equal(s.app.memory.pending[0]?.state, 'stopped');
  s.gateway.push('*2*0*21##');
  await s.clock.advance(10);
  assert.equal(s.app.memory.pending.length, 1, 'an echo of the state at the click');
  s.gateway.silent.clear();
  await s.clock.advance(MINUTE);
  assert.equal(s.app.memory.pending.length, 0, 'a read showed it stopped');
});

test('a kept stop goes before any other request as soon as the link is free', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.app.memory.pending.push({
    kind: 'shutterStop',
    target: 'shutter:21',
    frame: '*2*0*21##',
    at: s.clock.now(),
    tries: 0,
    state: 'up',
  });
  const from = s.gateway.commands.length;
  await s.click('light', '11', 'binary', 1);
  const after = s.gateway.commands.slice(from);
  assert.ok(after.indexOf('*2*0*21##') !== -1, after.join(' '));
  assert.ok(after.indexOf('*2*0*21##') < after.indexOf('*1*1*11##'), after.join(' '));
});
