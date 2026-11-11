// -----------------------------------------------------------------------------
// Frames: the bounded reader, the parser, the decoder, the frames sent.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAMES,
  FrameReader,
  coarsePreset,
  decode,
  encodeTemperature,
  isPoint,
  modeOf,
  parse,
  pointOf,
  temperatureOf,
  zoneOf,
} from '../src/own/frames.js';

const read = (...chunks) => {
  const frames = [];
  let drops = 0;
  const reader = new FrameReader({ onFrame: (f) => frames.push(f), onDrop: () => (drops += 1) });
  for (const chunk of chunks) reader.push(Buffer.from(chunk, 'latin1'));
  return { frames, drops };
};

test('reader: frames split across chunks, glued, garbage dropped', () => {
  assert.deepEqual(read('*1*1*1', '1##*#*1##').frames, ['*1*1*11##', '*#*1##']);
  const { frames, drops } = read('abc*1*x11##\r\n*2*0*21##é*1*0*12##');
  assert.deepEqual(frames, ['*2*0*21##', '*1*0*12##']);
  assert.ok(drops > 0);
});

test('reader: a frame over 256 bytes is dropped, the next one read', () => {
  const { frames } = read(`*1*${'1'.repeat(300)}`, '##*1*1*11##');
  assert.deepEqual(frames, ['*1*1*11##']);
});

test('parse: signalling, status, requests, dimensions', () => {
  assert.equal(parse('*#*1##').kind, 'ack');
  assert.equal(parse('*#*0##').kind, 'nack');
  assert.deepEqual(parse('*98*2##'), { kind: 'sha', raw: '*98*2##', version: '2' });
  assert.equal(parse('*#603356072##').nonce, '603356072');
  assert.notEqual(parse('*#12##').kind, 'nonce', 'short digits: not a nonce');
  assert.deepEqual(parse('*1*1*12#4#01##').where, '12#4#01');
  assert.equal(parse('*#1*12*1*150*0##').kind, 'dimension');
  assert.equal(parse('*#1*12*#1*150*0##').kind, 'dimensionWrite');
  assert.equal(parse('*#4*1*14##').kind, 'dimensionRequest');
  assert.equal(parse('*1*1##').kind, 'unknown');
  assert.equal(parse('nope').kind, 'unknown');
});

test('points: OWNd is_apl_address; areas, general and groups are not points', () => {
  for (const p of ['11', '99', '01', '0001', '0015', '0110', '0915', '1001', '1015']) {
    assert.ok(isPoint(p), p);
  }
  for (const p of ['0', '1', '00', '10', '100', '0016', '0109', '1016', '1101', '#1', '123']) {
    assert.ok(!isPoint(p), p);
  }
  assert.equal(pointOf('12#4#01'), '12#4#01');
  assert.equal(pointOf('12#4#16'), undefined);
  assert.equal(pointOf('12#4#00'), undefined);
  assert.equal(pointOf('*12'), undefined);
});

test('zones: 1 to 99, through the central unit or not; probes and actuators are not zones', () => {
  assert.equal(zoneOf('3'), 3);
  assert.equal(zoneOf('#3'), 3);
  assert.equal(zoneOf('99'), 99);
  for (const w of ['0', '#0', '100', '203', '3#1', '#0#1', ''])
    assert.equal(zoneOf(w), undefined, w);
});

test('lights: on, off, coarse steps, levels; the rest is no state', () => {
  assert.deepEqual(decode(parse('*1*0*11##')), { who: 1, point: '11', on: false, level: 0 });
  assert.deepEqual(decode(parse('*1*1*11##')), { who: 1, point: '11', on: true });
  assert.equal(decode(parse('*1*9*11##')).level, 75);
  assert.deepEqual(decode(parse('*#1*13*1*150*0##')), {
    who: 1,
    point: '13',
    on: true,
    level: 50,
    dimmer: true,
    coarse: false,
  });
  assert.equal(decode(parse('*#1*13*1*150*240##')).coarse, true);
  assert.equal(decode(parse('*#1*13*4*100*0##')).on, false);
  for (const f of [
    '*1*19*11##',
    '*1*34*11##',
    '*1*20*11##',
    '*#1*13*1*250*0##',
    '*#1*13*1**##',
    '*1*1*0##',
    '*1*1*1##',
  ]) {
    assert.equal(decode(parse(f)), undefined, f);
  }
});

test('shutters: moving, stopped, the advanced status with its position', () => {
  assert.equal(decode(parse('*2*1*21##')).motion, 'up');
  assert.equal(decode(parse('*2*2*21##')).motion, 'down');
  assert.equal(decode(parse('*2*0*21##')).motion, 'stopped');
  assert.deepEqual(decode(parse('*#2*22*10*10*45*0*0##')), {
    who: 2,
    point: '22',
    motion: 'stopped',
    advanced: true,
    position: 45,
  });
  assert.equal(decode(parse('*#2*22*10*10*255*0*0##')).position, undefined);
  assert.equal(decode(parse('*2*5*21##')), undefined);
});

test('heating: temperatures, set points, modes (OWNd tables)', () => {
  assert.equal(temperatureOf('0215'), 21.5);
  assert.equal(temperatureOf('1050'), -5);
  assert.equal(temperatureOf('1000'), 0);
  assert.equal(temperatureOf('215'), undefined);
  assert.equal(temperatureOf('２１５０'), undefined);
  assert.equal(encodeTemperature(21.5), '0215');
  assert.throws(() => encodeTemperature(-1));
  assert.deepEqual(decode(parse('*#4*1*0*0195##')), { who: 4, zone: 1, temperature: 19.5 });
  assert.equal(
    decode(parse('*#4*#1*0*0195##')),
    undefined,
    'the zone of the central unit is no probe',
  );
  assert.deepEqual(decode(parse('*#4*1*14*0200*3##')), { who: 4, zone: 1, setpoint: 20 });
  assert.equal(decode(parse('*#4*1*0*0999##')), undefined, '99.9 °C: not a measure');
  assert.equal(decode(parse('*4*303*#1##')).mode, 'off');
  assert.equal(decode(parse('*4*1*1##')).season, 'heating');
  assert.equal(modeOf(102), 'protection');
  assert.equal(modeOf(311), 'auto');
  assert.equal(modeOf(1101), 'auto');
  assert.equal(modeOf(110), 'heating');
  assert.equal(modeOf(13005), 'heating');
  assert.equal(modeOf(210), 'cooling');
  assert.equal(modeOf(310), 'manual');
  assert.equal(modeOf(22), undefined);
});

test('frames sent: OWNd builders; nothing for a non-point, never a DIMENSION 22', () => {
  assert.equal(FRAMES.lightOn('12#4#01'), '*1*1*12#4#01##');
  assert.equal(FRAMES.dimmerSet('13', 40), '*#1*13*#1*140*0##');
  assert.equal(FRAMES.dimmerPreset('13', 60), '*1*8*13##');
  assert.equal(FRAMES.shutterPosition('22', 80), '*#2*22*#11#001*80##');
  assert.equal(FRAMES.zoneOff(3, 'central'), '*4*303*#3##');
  assert.equal(FRAMES.zoneOff(3, 'standalone'), '*4*303*3##');
  assert.equal(FRAMES.zoneSetpointSet(3, 21.5, 'central'), '*#4*#3*#14*0215*3##');
  assert.throws(() => FRAMES.lightOff('0'), RangeError);
  assert.throws(() => FRAMES.lightOff('1'), RangeError);
  assert.throws(() => FRAMES.shutterStop('11*1'), RangeError);
  assert.throws(() => FRAMES.zoneOff(0, 'central'), RangeError);
  assert.throws(() => FRAMES.dimmerSet('13', 0), RangeError);
  for (const value of Object.values(FRAMES)) {
    if (typeof value === 'string') assert.doesNotMatch(value, /\*#?22[*#]/);
  }
  assert.equal(coarsePreset(1), 2);
  assert.equal(coarsePreset(100), 10);
});
