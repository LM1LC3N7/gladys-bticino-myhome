// -----------------------------------------------------------------------------
// /data: bounded, never overwritten when unreadable, repaired on read; the
// configuration parsing.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, memoryStore, normalizeMemory } from '../src/store.js';
import { normalizeConfig, parseHost } from '../src/config.js';
import { CONFIG, SECOND, setup, testClock } from './helpers/app.js';

const tempDir = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bticino-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('fileStore: round trip, 0600, missing, broken, a FIFO never blocks', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'state.json');
  const store = fileStore({ path });
  assert.deepEqual(await store.load(), { missing: true });
  await store.save({ a: 1 });
  assert.deepEqual(await store.load(), { data: { a: 1 } });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{nope');
  assert.deepEqual(await store.load(), { broken: true });
  const fifo = join(dir, 'fifo');
  execFileSync('mkfifo', [fifo]);
  assert.deepEqual(await fileStore({ path: fifo }).load(), { broken: true });
});

test('fileStore: a write that never ends is bounded', async () => {
  const store = fileStore({ path: '/nowhere', timeout: 50, write: () => new Promise(() => {}) });
  await assert.rejects(store.save({ a: 1 }), /too slow/);
});

test('normalizeMemory: wrong entries dropped, future dates not trusted', () => {
  const now = Date.UTC(2026, 0, 1);
  const memory = normalizeMemory(
    {
      place: 'h:1',
      refused: { mark: 300, salt: 'xx' },
      mac: 'not-a-mac',
      lastReadAt: now + 1000,
      pending: [
        { kind: 'shutterStop', target: 'shutter:21', frame: '*2*0*21##', at: now - 5, tries: 0 },
        { kind: 'shutterUp', target: 'shutter:21', frame: '*2*1*21##', at: now - 5, tries: 0 },
        { kind: 'lightOff', target: 'light:11', frame: '*1*0*11##', at: now + 5, tries: 0 },
        { kind: 'lightOff', target: 'light:11', frame: 'GET / HTTP', at: now - 5, tries: 0 },
      ],
      dimmers: ['13', '0', 'x', '13'],
      __proto__: { polluted: true },
    },
    now,
  );
  assert.equal(memory.refused, null);
  assert.equal(memory.mac, null);
  assert.equal(memory.lastReadAt, 0);
  assert.equal(memory.pending.length, 1);
  assert.deepEqual(memory.dimmers, ['13']);
  assert.equal({}.polluted, undefined);
});

test('/data unreadable at start: never overwritten, read again every 10 s, then used', async (t) => {
  const store = memoryStore(
    { place: '192.168.1.35:20000', lastReadAt: Date.UTC(2026, 0, 1), dimmers: ['14'] },
    { broken: true },
  );
  const s = await setup({
    store,
    clock: testClock({ start: Date.UTC(2026, 0, 1) + 5 * 60 * SECOND }),
  });
  t.after(() => s.app.stop());
  assert.equal(store.saves, 0);
  assert.match(s.status().message.en, /\/data cannot be read/);
  store.broken = false;
  await s.clock.advance(11 * SECOND);
  assert.ok(store.saves > 0);
  assert.ok(store.data.dimmers.includes('14'), 'what the file held is kept');
  assert.doesNotMatch(s.status().message.en, /\/data cannot be read/);
});

test('configuration: address, port, lists, plant, option', () => {
  assert.deepEqual(parseHost('myhome.lan:20001'), { host: 'myhome.lan', port: 20001 });
  for (const bad of [
    'a b',
    'user@host',
    'http://x/y',
    '0.0.0.0',
    '239.1.1.1',
    '255.255.255.255',
    'x\ny',
  ]) {
    assert.equal(parseHost(bad).host, '', bad);
  }
  const config = normalizeConfig({
    ...CONFIG,
    dimmers: '13, 0215; 12#4#01 0 1 abc',
    zones: '1, 3, 0, 100, x',
    heating_plant: 'nope',
    allow_thermostat: 'true',
    password: ' 12345 ',
  });
  assert.deepEqual(config.dimmers, ['13', '0215', '12#4#01']);
  assert.deepEqual(config.zones, [1, 3]);
  assert.equal(config.errors.length, 6);
  assert.equal(config.plant, 'central');
  assert.equal(config.allowThermostat, false, 'only a true boolean allows');
  assert.equal(config.password, '12345');
  assert.equal(config.port, 20000);
  assert.equal(normalizeConfig({ password: 'mot de passe' }).passwordInvalid, true);
});

test('a wrong entry of the configuration is counted in the status, never shown', async (t) => {
  const s = await setup({ config: { ...CONFIG, zones: '1, secret-typed-here' } });
  t.after(() => s.app.stop());
  assert.match(s.status().message.en, /1 entry/);
  assert.ok(!JSON.stringify(s.gladys.fake.connectionStatuses).includes('secret-typed-here'));
});

test('a clean stop writes /data', async () => {
  const s = await setup();
  const before = s.store.saves;
  await s.app.stop();
  assert.ok(s.store.saves > before);
  assert.equal(s.clock.pending, 0, 'no timer left');
});
