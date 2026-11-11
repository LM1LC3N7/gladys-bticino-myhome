// -----------------------------------------------------------------------------
// Thermostats: set point and automatic mode off by default, the option
// checked at every step, the zone read just before, the bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, setup } from './helpers/app.js';

const ALLOWED = { ...CONFIG, allow_thermostat: true };

test('off by default: set point and automatic refused, nothing sent', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  const before = s.gateway.commands.length;
  let click = await s.click('zone', '1', 'target', 21);
  assert.equal(click.ack?.success, false);
  assert.match(click.ack.error.message, /désactivé/);
  click = await s.click('zone', '1', 'mode', 3);
  assert.equal(click.ack?.success, false);
  assert.equal(s.gateway.commands.length, before);
});

test('allowed: the zone read first, the set point written, read back', async (t) => {
  const s = await setup({ config: ALLOWED });
  t.after(() => s.app.stop());
  const click = await s.click('zone', '1', 'target', 21.3);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  const read = s.gateway.commands.lastIndexOf(
    '*#4*1*14##',
    s.gateway.commands.indexOf('*#4*#1*#14*0215*3##'),
  );
  assert.ok(read >= 0, 'read before');
  assert.equal(s.sent('*#4*#1*#14*0215*3##'), 1, 'half degrees');
  assert.equal(s.gateway.zones.get(1).setpoint, 21.5);
});

test('the same set point: nothing written', async (t) => {
  const s = await setup({ config: ALLOWED });
  t.after(() => s.app.stop());
  const click = await s.click('zone', '1', 'target', 20);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  assert.equal(s.gateway.commands.filter((f) => f.includes('*#14*')).length, 0);
});

test('bounds: under 5 or over 40 °C refused; a stand-alone thermostat takes the plain zone', async (t) => {
  const s = await setup({ config: { ...ALLOWED, heating_plant: 'standalone' } });
  t.after(() => s.app.stop());
  for (const value of [4.9, 40.5, 100, -3, 'abc', null]) {
    const click = await s.click('zone', '1', 'target', value, { wait: 100 });
    assert.equal(click.ack?.success, false, String(value));
  }
  assert.equal(s.gateway.commands.filter((f) => f.includes('*#14*')).length, 0);
  const click = await s.click('zone', '1', 'target', 40);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  assert.equal(s.sent('*#4*1*#14*0400*3##'), 1);
  const auto = await s.click('zone', '1', 'mode', 3);
  assert.equal(auto.ack?.success, false);
  assert.match(auto.ack.error.message, /autonome/);
});

test('the zone cannot be read just before: refused, nothing written', async (t) => {
  const s = await setup({ config: ALLOWED });
  t.after(() => s.app.stop());
  s.gateway.silent.add('*#4*1*14##');
  const click = await s.click('zone', '1', 'target', 22);
  assert.equal(click.ack?.success, false);
  assert.equal(s.gateway.commands.filter((f) => f.includes('*#14*')).length, 0);
});

test('the option switched off while the zone is read: withdrawn, nothing written', async (t) => {
  const s = await setup({ config: ALLOWED, gateway: { latency: 300 } });
  t.after(() => s.app.stop());
  const click = await s.click('zone', '1', 'target', 22, { wait: 100 });
  await s.app.configUpdated({ ...CONFIG, allow_thermostat: false });
  await s.clock.advance(4000);
  assert.equal(click.ack?.success, false);
  assert.equal(s.gateway.commands.filter((f) => f.includes('*#14*')).length, 0);
});

test('automatic: back to the program of the central unit', async (t) => {
  const s = await setup({ config: ALLOWED });
  t.after(() => s.app.stop());
  await s.click('zone', '1', 'mode', 0);
  const click = await s.click('zone', '1', 'mode', 3);
  assert.equal(click.ack?.success, true, click.ack?.error?.message);
  assert.equal(s.sent('*4*311*#1##'), 1);
  assert.equal(s.state('zone', '1', 'mode'), 3);
  const heat = await s.click('zone', '1', 'mode', 1);
  assert.equal(heat.ack?.success, false);
});

test('a set point is refused while the zone is being switched off', async (t) => {
  const s = await setup({ config: ALLOWED });
  t.after(() => s.app.stop());
  s.app.memory.pending.push({
    kind: 'zoneOff',
    target: 'zone:1',
    frame: '*4*303*#1##',
    at: s.clock.now(),
    tries: 0,
  });
  const click = await s.click('zone', '1', 'target', 23);
  assert.equal(click.ack?.success, false);
  assert.match(click.ack.error.message, /extinction/);
});

test('the option switched off right before the write: withdrawn, nothing written', async (t) => {
  const s = await setup({ config: ALLOWED });
  t.after(() => s.app.stop());
  const submit = s.app.command.submit.bind(s.app.command);
  s.app.command.submit = (job) => {
    if (job.frame.includes('*#14*')) s.app.config.allowThermostat = false;
    return submit(job);
  };
  const click = await s.click('zone', '1', 'target', 22);
  assert.equal(click.ack?.success, false);
  assert.match(click.ack.error.message, /désactivé/);
  assert.equal(s.gateway.commands.filter((f) => f.includes('*#14*')).length, 0);
});
