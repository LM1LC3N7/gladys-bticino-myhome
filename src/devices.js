// -----------------------------------------------------------------------------
// The model of the installation -> Gladys devices and states (pure).
//
// One device per light point, per shutter, per heating zone, keyed by its
// OpenWebNet address as MyHOME_Suite shows it (`ext:<selector>:light:12`,
// `ext:<selector>:shutter:0215`, `ext:<selector>:zone:3`; a point behind a
// bus interface, `12#4#01`, is `12-4-01`): a MyHOME installation is wired by
// address, the frames carry nothing else. Features:
// - light: `binary` (light/binary), plus `brightness` (light/brightness) on a
//   dimmer; a point set read only gets `readonly` (a state, never a command:
//   no voice assistant nor "turn everything off" can drive it);
// - shutter: `state` (shutter/state: open, close, stop), plus `position`
//   (shutter/position, 0 closed to 100 open) on a shutter that gives it;
// - zone: `temperature`, `target` (the set point), `mode` (off, heating,
//   cooling, automatic). Never a switch.
// A device published again never loses a feature the user created: the
// features of the created device that are not built any more are kept.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { COVER_STATE, LIMITS, THERMOSTAT_MODE, TIMINGS } from './constants.js';
import { DEVICE_NAMES, FEATURE_NAMES, MODE_LABELS, word } from './i18n.js';
import { pointOf } from './own/frames.js';

const command = (category, type, extra = {}) => ({
  category,
  type,
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...extra,
});

const reading = (category, type, extra = {}) => ({
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

export const LIGHT_FEATURES = {
  binary: command(C.LIGHT, T.LIGHT.BINARY, { min: 0, max: 1 }),
  brightness: command(C.LIGHT, T.LIGHT.BRIGHTNESS, { min: 0, max: 100 }),
  readonly: reading(C.UNKNOWN, T.SENSOR.BINARY, { min: 0, max: 1 }),
};

export const SHUTTER_FEATURES = {
  state: command(C.SHUTTER, T.SHUTTER.STATE, {
    min: COVER_STATE.CLOSE,
    max: COVER_STATE.OPEN,
    keep_history: false,
  }),
  position: command(C.SHUTTER, T.SHUTTER.POSITION, { min: 0, max: 100 }),
};

const options = (entries, language) =>
  entries.map(([value, label]) => ({ value, label: word(label, language) }));

/**
 * The features of a zone. The mode offers what can be chosen: off, and the
 * program of the central unit (none on a stand-alone thermostat); heating
 * and cooling are reported, set by a set point.
 */
export function zoneFeatures(language, plant = 'central') {
  const choices = [[THERMOSTAT_MODE.OFF, MODE_LABELS.off]];
  if (plant !== 'standalone') choices.push([THERMOSTAT_MODE.AUTO, MODE_LABELS.auto]);
  return {
    temperature: reading(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, {
      unit: U.CELSIUS,
      min: -40,
      max: 80,
    }),
    target: command(C.THERMOSTAT, T.THERMOSTAT.TARGET_TEMPERATURE, {
      unit: U.CELSIUS,
      min: LIMITS.minSetpoint,
      max: LIMITS.maxSetpoint,
    }),
    mode: command(C.THERMOSTAT, T.THERMOSTAT.MODE, {
      min: 0,
      max: 3,
      keep_history: false,
      supported_options: options(choices, language),
    }),
  };
}

/** `12#4#01` -> `12-4-01` (no `#` in an id). */
export const pointId = (point) => point.replace(/#/g, '-');
/** `12-4-01` -> `12#4#01`, undefined if not a point. */
export const pointFromId = (id) => pointOf(String(id ?? '').replace(/-/g, '#'));

/** `ext:sel:light:12:binary` -> { kind, id, key, point | zone }; undefined if not ours. */
export function parseFeatureId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) return undefined;
  const prefix = gladys.externalId('');
  if (!externalId.startsWith(prefix)) return undefined;
  const parts = externalId.slice(prefix.length).split(':');
  if (parts.length !== 3) return undefined;
  const [kind, id, key] = parts;
  if (kind === 'light' || kind === 'shutter') {
    const point = pointFromId(id);
    return point ? { kind, id, key, point } : undefined;
  }
  if (kind === 'zone' && /^[1-9][0-9]?$/.test(id)) return { kind, id, key, zone: Number(id) };
  return undefined;
}

/** What a discovered feature declares (a created one also has ids, values, dates). */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'unit',
  'supported_options',
];

/** Adds to each device the features of its created twin it no longer has. */
export function keepCreatedFeatures(devices, created = []) {
  const byId = new Map((created ?? []).map((device) => [device?.external_id, device]));
  return devices.map((device) => {
    const twin = byId.get(device.external_id);
    if (!twin?.features?.length) return device;
    const have = new Set(device.features.map((f) => f.external_id));
    const kept = twin.features
      .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
      .map((f) =>
        Object.fromEntries(
          FEATURE_FIELDS.filter((key) => f[key] !== undefined && f[key] !== null).map((key) => [
            key,
            f[key],
          ]),
        ),
      );
    return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
  });
}

const byAddress = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/** The light kind of a point: readonly, dimmer or light. */
export function lightKind(model, config, point) {
  if (config.readOnly.includes(point)) return 'readonly';
  return model.dimmers.has(point) ? 'dimmer' : 'light';
}

export function buildDevices(gladys, config, model, created = gladys.devices) {
  const { language } = config;
  const devices = [];
  for (const point of [...model.lightPoints].sort(byAddress)) {
    const ids = gladys.externalIds('light', pointId(point));
    const kind = lightKind(model, config, point);
    const keys =
      kind === 'readonly'
        ? ['readonly']
        : kind === 'dimmer'
          ? ['binary', 'brightness']
          : ['binary'];
    devices.push({
      name: word(DEVICE_NAMES[kind === 'dimmer' ? 'dimmer' : 'light'], language)(point),
      external_id: ids.device,
      model: kind === 'dimmer' ? 'MyHOME dimmer' : 'MyHOME light point',
      should_poll: false,
      params: [{ name: 'address', value: point }],
      features: keys.map((key) => ({
        name: word(FEATURE_NAMES[key], language),
        external_id: ids.feature(key),
        ...LIGHT_FEATURES[key],
      })),
    });
  }
  for (const point of [...model.shutterPoints].sort(byAddress)) {
    const ids = gladys.externalIds('shutter', pointId(point));
    const keys = model.advanced.has(point) ? ['state', 'position'] : ['state'];
    devices.push({
      name: word(DEVICE_NAMES.shutter, language)(point),
      external_id: ids.device,
      model: 'MyHOME shutter',
      should_poll: false,
      params: [{ name: 'address', value: point }],
      features: keys.map((key) => ({
        name: word(FEATURE_NAMES[key], language),
        external_id: ids.feature(key),
        ...SHUTTER_FEATURES[key],
      })),
    });
  }
  const features = zoneFeatures(language, config.plant);
  for (const zone of [...model.zoneNumbers].sort((a, b) => a - b)) {
    const ids = gladys.externalIds('zone', String(zone));
    devices.push({
      name: word(DEVICE_NAMES.zone, language)(zone),
      external_id: ids.device,
      model: 'MyHOME heating zone',
      should_poll: false,
      params: [
        { name: 'zone', value: String(zone) },
        { name: 'plant', value: config.plant },
      ],
      features: Object.entries(features).map(([key, definition]) => ({
        name: word(FEATURE_NAMES[key], language),
        external_id: ids.feature(key),
        ...definition,
      })),
    });
  }
  return keepCreatedFeatures(devices, created);
}

/** Gladys shutter state: moving up = open, down = close, stopped = stop. */
export function shutterState(state) {
  if (state.motion === 'up') return COVER_STATE.OPEN;
  if (state.motion === 'down') return COVER_STATE.CLOSE;
  if (state.motion === 'stopped') return COVER_STATE.STOP;
  return undefined;
}

export function modeValue(mode) {
  if (mode === 'off' || mode === 'protection') return THERMOSTAT_MODE.OFF;
  if (mode === 'auto') return THERMOSTAT_MODE.AUTO;
  if (mode === 'heating') return THERMOSTAT_MODE.HEATING;
  if (mode === 'cooling') return THERMOSTAT_MODE.COOLING;
  return undefined;
}

/**
 * Every fresh state: `[{ device_feature_external_id, state }]`. A value
 * older than TIMINGS.stale (monotonic `now`) is not published: it would be
 * shown as new.
 */
export function buildStates(gladys, config, model, now) {
  const states = [];
  const fresh = (at) => at !== undefined && now - at <= TIMINGS.stale;
  const push = (ids, key, value) => {
    if (value === undefined || value === null || Number.isNaN(value)) return;
    states.push({ device_feature_external_id: ids.feature(key), state: value });
  };
  for (const point of model.lightPoints) {
    const state = model.lights.get(point);
    if (!state || !fresh(state.at)) continue;
    const ids = gladys.externalIds('light', pointId(point));
    const kind = lightKind(model, config, point);
    if (kind === 'readonly') {
      push(ids, 'readonly', state.on ? 1 : 0);
      continue;
    }
    push(ids, 'binary', state.on ? 1 : 0);
    if (kind === 'dimmer' && state.level !== undefined) push(ids, 'brightness', state.level);
  }
  for (const point of model.shutterPoints) {
    const state = model.shutters.get(point);
    if (!state || !fresh(state.at)) continue;
    const ids = gladys.externalIds('shutter', pointId(point));
    push(ids, 'state', shutterState(state));
    if (model.advanced.has(point) && fresh(state.positionAt)) push(ids, 'position', state.position);
  }
  for (const zone of model.zoneNumbers) {
    const state = model.zones.get(zone);
    if (!state) continue;
    const ids = gladys.externalIds('zone', String(zone));
    if (fresh(state.temperatureAt)) push(ids, 'temperature', state.temperature);
    if (fresh(state.setpointAt)) push(ids, 'target', state.setpoint);
    if (fresh(state.modeAt)) push(ids, 'mode', modeValue(state.mode));
  }
  return states;
}
