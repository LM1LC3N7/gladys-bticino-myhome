// -----------------------------------------------------------------------------
// The OPEN password: the three methods, a refusal remembered (never the
// password), the gateway that must prove it knows the password, another
// gateway at the address, the secret never written anywhere.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CONFIG, SECOND, SECRET, setup, testClock } from './helpers/app.js';
import { NONCE } from './helpers/fakeGateway.js';
import {
  digitsToHex,
  hexToDigits,
  hmacAnswer,
  hmacExpected,
  openPassword,
} from '../src/own/auth.js';
import { passwordMark } from '../src/config.js';
import { memoryStore } from '../src/store.js';

test('the legacy OPEN answer: the published example (password 12345)', () => {
  assert.equal(openPassword('12345', NONCE), 25280520);
  assert.equal(digitsToHex('0102031015'), '123af');
  assert.equal(hexToDigits('a0f'), '100015');
});

test('the HMAC answers: SHA-1 and SHA-256, the client and the gateway differ', () => {
  const ra = '0102030405';
  const rb = '0607080900';
  for (const [algorithm, length] of [
    ['sha1', 80],
    ['sha256', 128],
  ]) {
    const answer = hmacAnswer(algorithm, 'pass', ra, rb);
    assert.equal(answer.length, length);
    assert.match(answer, /^[0-9]+$/);
    assert.notEqual(answer, hmacExpected(algorithm, 'pass', ra, rb));
    const expected = createHash(algorithm)
      .update(
        `${digitsToHex(ra)}${digitsToHex(rb)}736F70653E636F70653E${createHash(algorithm).update('pass').digest('hex')}`,
      )
      .digest('hex');
    assert.equal(answer, hexToDigits(expected));
  }
});

for (const auth of ['nonce', 'sha1', 'sha2']) {
  test(`${auth}: the right password opens both sessions`, async (t) => {
    const password = auth === 'nonce' ? '12345' : SECRET;
    const s = await setup({ config: { ...CONFIG, password }, gateway: { auth, password } });
    t.after(() => s.app.stop());
    assert.equal(s.status()?.connected, true, JSON.stringify(s.status()));
    assert.equal(s.gateway.sessions.event, 1);
    assert.ok(s.gateway.sessions.command >= 1);
  });
}

test('a refused password: stopped, remembered by an 8-bit mark, never sent again after a restart', async (t) => {
  const store = memoryStore();
  const s = await setup({
    store,
    config: { ...CONFIG, password: SECRET },
    gateway: { auth: 'sha2', password: 'other' },
  });
  assert.equal(s.status().connected, false);
  assert.match(s.status().message.en, /refused the OPEN password/);
  await s.clock.advance(10 * 60 * SECOND);
  assert.equal(s.gateway.connections, 1, 'no new try by itself');
  const click = await s.click('light', '12', 'binary', 0);
  assert.equal(click.ack?.success, false, 'never with a refused password');
  assert.equal(s.gateway.connections, 1);
  await s.app.stop();
  assert.ok(store.data.refused);
  assert.ok(store.data.refused.mark >= 0 && store.data.refused.mark <= 255);
  assert.ok(!JSON.stringify(store.data).includes(SECRET));
  const s2 = await setup({
    store,
    config: { ...CONFIG, password: SECRET },
    gateway: { auth: 'sha2', password: 'other' },
    clock: testClock({ start: Date.UTC(2026, 0, 1) + 60 * SECOND }),
  });
  t.after(() => s2.app.stop());
  assert.equal(s2.gateway.connections, 0, 'the restart does not send it again');
  assert.match(s2.status().message.en, /refused the OPEN password/);
  // A new password is tried at once, and lifts the mark.
  s2.gateway.password = 'new-one';
  await s2.app.configUpdated({ ...CONFIG, password: 'new-one' });
  await s2.clock.advance(100);
  await s2.clock.advance(100);
  assert.equal(s2.status().connected, true);
  assert.equal(store.data.refused, null);
});

test('the mark cannot find the password: one candidate in about 256 shares it', () => {
  const salt = '0123456789abcdef';
  const mark = passwordMark(SECRET, salt);
  let same = 0;
  for (let i = 0; i < 10_000; i += 1) if (passwordMark(`guess${i}`, salt) === mark) same += 1;
  assert.ok(same > 10 && same < 100, `${same} candidates share the mark`);
});

test('"Test the connection" lifts a refusal (one new try)', async (t) => {
  const s = await setup({
    config: { ...CONFIG, password: SECRET },
    gateway: { auth: 'sha1', password: 'other' },
  });
  t.after(() => s.app.stop());
  s.gateway.password = SECRET;
  const result = await s.app.testConnection();
  assert.match(result.en, /Connected/);
});

test('two sessions closed right after the password: a refusal', async (t) => {
  const s = await setup({
    config: { ...CONFIG, password: '12345' },
    gateway: { auth: 'nonce', password: '12345', dropAfterPassword: true },
  });
  t.after(() => s.app.stop());
  await s.clock.advance(15 * SECOND);
  assert.match(s.status().message.en, /refused the OPEN password/);
  const tries = s.gateway.connections;
  await s.clock.advance(10 * 60 * SECOND);
  assert.equal(s.gateway.connections, tries);
});

test('no password but the gateway asks one: said, nothing sent', async (t) => {
  const s = await setup({ gateway: { auth: 'sha2', password: SECRET } });
  t.after(() => s.app.stop());
  assert.match(s.status().message.en, /asks for its OPEN password/);
  assert.ok(!s.gateway.received.some((f) => /^\*#[0-9]+\*[0-9]+##$/.test(f)));
});

test('a legacy gateway and a password with letters: never sent', async (t) => {
  const s = await setup({
    config: { ...CONFIG, password: 'abc12' },
    gateway: { auth: 'nonce', password: '12' },
  });
  t.after(() => s.app.stop());
  assert.match(s.status().message.en, /digits/);
  assert.equal(s.gateway.received.filter((f) => /^\*#[0-9]+##$/.test(f)).length, 0);
});

test('a gateway that cannot prove it knows the password: stopped', async (t) => {
  const s = await setup({
    config: { ...CONFIG, password: SECRET },
    gateway: { auth: 'sha2', password: SECRET, impostor: true },
  });
  t.after(() => s.app.stop());
  assert.match(s.status().message.en, /did not prove/);
  await s.clock.advance(10 * 60 * SECOND);
  assert.equal(s.gateway.connections, 1);
});

test('another gateway at the address (another MAC): commands stopped until the button', async (t) => {
  const store = memoryStore();
  const s = await setup({ store });
  await s.app.stop();
  assert.equal(store.data.mac, '00:03:50:01:02:03');
  const s2 = await setup({
    store,
    gateway: { mac: [0, 3, 80, 9, 9, 9] },
    clock: testClock({ start: Date.UTC(2026, 0, 1) + 2 * 60 * SECOND }),
  });
  t.after(() => s2.app.stop());
  assert.match(s2.status().message.en, /Another gateway/);
  const click = await s2.click('light', '11', 'binary', 1);
  assert.equal(click.ack?.success, false);
  assert.equal(s2.sent('*1*1*11##'), 0);
  const result = await s2.app.testConnection();
  assert.match(result.en, /Connected/);
  assert.equal(store.data.mac, '00:03:50:09:09:09');
});

test('the password never reaches the logs, the status, /data, the devices', async (t) => {
  const store = memoryStore();
  const s = await setup({
    store,
    config: { ...CONFIG, password: SECRET },
    gateway: { auth: 'sha2', password: SECRET },
  });
  await s.click('light', '11', 'binary', 1);
  s.gateway.password = 'changed';
  for (const socket of s.gateway.open) socket.destroy();
  await s.clock.advance(20 * SECOND);
  await s.app.stop();
  t.after(() => s.app.stop());
  const everything = JSON.stringify([
    s.logger.lines,
    s.gladys.fake.connectionStatuses,
    store.data,
    s.gladys.fake.discoveredDevices,
  ]);
  assert.ok(!everything.includes(SECRET));
  assert.ok(s.logger.lines.length > 0);
});

test('a gateway silent after the right password is never a refusal: tried again with the waits', async (t) => {
  const store = memoryStore();
  const s = await setup({
    store,
    config: { ...CONFIG, password: '12345' },
    gateway: { auth: 'nonce', password: '12345', silentAfterPassword: true },
  });
  t.after(() => s.app.stop());
  await s.clock.advance(3 * 60 * SECOND);
  assert.equal(s.app.stopKind, undefined);
  assert.equal(store.data?.refused ?? null, null);
  assert.doesNotMatch(s.status().message.en, /refused/);
  const tries = s.gateway.sessions.event;
  assert.ok(tries >= 3, `${tries} sessions`);
  s.gateway.silentAfterPassword = false;
  await s.clock.advance(6 * 60 * SECOND);
  assert.equal(s.status().connected, true);
});

test('the event session lost then back on another gateway: no command before its MAC, then stopped', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  // Gateway B answers at the same address from now on.
  s.gateway.mac = [0, 3, 80, 9, 9, 9];
  for (const socket of s.gateway.open) socket.destroy();
  await s.clock.advance(10);
  assert.equal(s.app.identity, 'unknown');
  const from = s.gateway.commands.length;
  const click = await s.click('light', '12', 'binary', 1);
  const after = s.gateway.commands.slice(from);
  assert.equal(click.ack?.success, false);
  assert.ok(!after.includes('*1*1*12##'), after.join(' '));
  assert.equal(after[0], '*#13**12##');
  assert.match(s.status().message.en, /Another gateway/);
});

test('a new command session (idle closed) reads the MAC before a command', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.clock.advance(30 * SECOND); // idle close of the command session
  s.gateway.mac = [0, 3, 80, 9, 9, 9];
  const from = s.gateway.commands.length;
  const click = await s.click('light', '12', 'binary', 1);
  assert.equal(click.ack?.success, false);
  assert.ok(!s.gateway.commands.slice(from).includes('*1*1*12##'));
});

test('event frames are not taken before the MAC of the session is known', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.app.eventIdentity = 'unknown';
  s.gateway.push('*1*1*11##');
  await s.clock.advance(10);
  assert.equal(s.state('light', '11', 'binary'), 0);
});

test('a gateway that cannot prove the password: remembered, not answered again after a restart', async (t) => {
  const store = memoryStore();
  const s = await setup({
    store,
    config: { ...CONFIG, password: SECRET },
    gateway: { auth: 'sha2', password: SECRET, impostor: true },
  });
  await s.app.stop();
  assert.equal(store.data.refused?.kind, 'identity');
  const s2 = await setup({
    store,
    config: { ...CONFIG, password: SECRET },
    gateway: { auth: 'sha2', password: SECRET, impostor: true },
    clock: testClock({ start: Date.UTC(2026, 0, 1) + 60 * SECOND }),
  });
  t.after(() => s2.app.stop());
  assert.equal(s2.gateway.connections, 0);
  assert.match(s2.status().message.en, /did not prove/);
});

test('an invalid password in the configuration: a stop is kept, nothing sent, then sent first once fixed', async (t) => {
  const s = await setup({ config: { ...CONFIG, password: 'mot de passe' } });
  t.after(() => s.app.stop());
  const click = await s.click('shutter', '21', 'state', 0, { wait: 100 });
  assert.equal(click.ack?.success, false);
  assert.match(click.ack.error.message, /gardée/);
  assert.equal(s.app.memory.pending.length, 1);
  assert.equal(s.gateway.connections, 0);
  await s.app.configUpdated({ ...CONFIG });
  await s.clock.advance(100);
  await s.clock.advance(100);
  assert.equal(s.gateway.commands[0], '*2*0*21##');
  assert.equal(s.app.memory.pending.length, 0);
});

test('a stop clicked while the password is refused: kept, the refused password never sent again, first with the new one', async (t) => {
  const s = await setup({
    config: { ...CONFIG, password: SECRET },
    gateway: { auth: 'sha2', password: 'other' },
  });
  t.after(() => s.app.stop());
  s.gateway.shutters.get('21').motion = 1;
  const connections = s.gateway.connections;
  const click = await s.click('shutter', '21', 'state', 0, { wait: 100 });
  assert.equal(click.ack?.success, false);
  assert.match(click.ack.error.message, /mot de passe est corrigé/);
  assert.equal(s.gateway.connections, connections);
  s.gateway.password = 'other';
  await s.app.configUpdated({ ...CONFIG, password: 'other' });
  await s.clock.advance(100);
  await s.clock.advance(100);
  assert.equal(s.gateway.commands[0], '*2*0*21##');
  assert.equal(s.gateway.shutters.get('21').motion, 0);
});

test('a wall button right after a protective opened a new command session is taken', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.clock.advance(30 * SECOND); // idle close of the command session
  const click = await s.click('light', '12', 'binary', 0);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  s.gateway.push('*1*1*11##');
  await s.clock.advance(10);
  assert.equal(s.state('light', '11', 'binary'), 1);
});

test('the MAC unreadable when the events open: tried again within 30 s, events taken then', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gateway.silent.add('*#13**12##');
  for (const socket of s.gateway.open) if (socket.session === 'event') socket.destroy();
  await s.clock.advance(11 * SECOND);
  await s.clock.advance(20 * SECOND);
  assert.ok(s.sent('*#13**12##') >= 2, 'asked and unanswered');
  assert.equal(s.app.eventIdentity, 'unknown');
  s.gateway.silent.clear();
  await s.clock.advance(40 * SECOND);
  assert.equal(s.app.eventIdentity, 'ok');
  s.gateway.push('*1*1*11##');
  await s.clock.advance(10);
  assert.equal(s.state('light', '11', 'binary'), 1);
});

test('two callers of the MAC at once share one request', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.app.identity = 'unknown';
  const before = s.sent('*#13**12##');
  const both = Promise.all([s.app.readIdentity(), s.app.readIdentity()]);
  await s.clock.advance(100);
  await both;
  assert.equal(s.sent('*#13**12##') - before, 1);
});

test('a flapping event session: one MAC request per reconnection, the full reads keep their calendar', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const reads = s.sent('*#1*0##');
  const macs = s.sent('*#13**12##');
  let ups = 0;
  s.app.events.on('up', () => (ups += 1));
  for (let i = 0; i < 8; i += 1) {
    for (const socket of s.gateway.open) if (socket.session === 'event') socket.destroy();
    await s.clock.advance(11 * SECOND);
  }
  assert.ok(ups >= 1);
  assert.equal(s.sent('*#1*0##') - reads, 0, 'no full read for short drops within 10 min');
  assert.ok(
    s.sent('*#13**12##') - macs <= ups + 1,
    `${s.sent('*#13**12##') - macs} MAC for ${ups} ups`,
  );
});
