// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { DEFAULT_PORT, HEATING_PLANTS, LANGUAGES, LIMITS } from './constants.js';
import { pointOf } from './own/frames.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  host: '',
  port: DEFAULT_PORT,
  password: '',
  dimmers: '',
  read_only: '',
  zones: '',
  heating_plant: 'central',
  allow_thermostat: false,
  language: 'fr',
};

const integer = (value, fallback, min, max) => {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};

/**
 * `192.168.1.35`, `myhome.lan:20000` -> { host, port? }. Control characters,
 * spaces, a user part or a path: no host (the configuration is said invalid).
 */
export function parseHost(raw) {
  const text = String(raw ?? '').trim();
  // eslint-disable-next-line no-control-regex
  if (text === '' || /[\s@/\\?#\x00-\x1f\x7f]/.test(text)) return { host: '' };
  const match = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d{1,5}))?$/i.exec(text);
  if (!match) return { host: '' };
  const host = match[1].replace(/^\[|\]$/g, '');
  if (host === '0.0.0.0' || host === '::' || /^(255\.){3}255$/.test(host)) return { host: '' };
  if (/^2(2[4-9]|3[0-9])\./.test(host) || /^ff[0-9a-f]{2}:/i.test(host)) return { host: '' };
  const port = match[2] ? Number(match[2]) : undefined;
  return { host, port: port >= 1 && port <= 65535 ? port : undefined };
}

/** `12, 0215; 13#4#01` -> { points: [...], errors: [...] }, each point once, bounded. */
export function parsePoints(raw) {
  const points = [];
  const errors = [];
  for (const entry of String(raw ?? '').split(/[,;\s]+/)) {
    const text = entry.trim();
    if (text === '') continue;
    const point = pointOf(text);
    if (!point) errors.push(text.slice(0, 20));
    else if (!points.includes(point) && points.length < LIMITS.points) points.push(point);
  }
  return { points, errors };
}

/** `1, 2, 5` -> { zones: [1, 2, 5], errors: [...] }. */
export function parseZones(raw) {
  const zones = [];
  const errors = [];
  for (const entry of String(raw ?? '').split(/[,;\s]+/)) {
    const text = entry.trim();
    if (text === '') continue;
    const zone = /^[0-9]{1,2}$/.test(text) ? Number(text) : NaN;
    if (!(zone >= 1 && zone <= 99)) errors.push(text.slice(0, 20));
    else if (!zones.includes(zone)) zones.push(zone);
  }
  return { zones: zones.sort((a, b) => a - b), errors };
}

export function normalizeConfig(raw = {}) {
  const { host, port: hostPort } = parseHost(raw?.host);
  const language = String(raw?.language ?? DEFAULT_CONFIG.language)
    .trim()
    .toLowerCase();
  const plant = String(raw?.heating_plant ?? DEFAULT_CONFIG.heating_plant).trim();
  const dimmers = parsePoints(raw?.dimmers);
  const readOnly = parsePoints(raw?.read_only);
  const zones = parseZones(raw?.zones);
  // As typed (a space may not be part of an OPEN password: the gateway only takes digits or letters).
  const password = typeof raw?.password === 'string' ? raw.password.trim() : '';
  return {
    host,
    // A port typed with the address wins over the port field (which has a default).
    port: hostPort ?? integer(raw?.port, DEFAULT_CONFIG.port, 1, 65535),
    password,
    passwordInvalid: password !== '' && !/^[\x21-\x7e]{1,64}$/.test(password),
    dimmers: dimmers.points,
    readOnly: readOnly.points,
    zones: zones.zones,
    errors: [...dimmers.errors, ...readOnly.errors, ...zones.errors],
    plant: HEATING_PLANTS.includes(plant) ? plant : DEFAULT_CONFIG.heating_plant,
    allowThermostat: raw?.allow_thermostat === true,
    language: LANGUAGES.includes(language) ? language : DEFAULT_CONFIG.language,
  };
}

/** What the sessions depend on: a change reconnects (and lifts a stop on a refused password). */
export const sessionKey = (config) => JSON.stringify([config.host, config.port, config.password]);

/** Where the sessions go, without the password: what /data ties its memory to. */
export const placeKey = (config) => `${config.host}:${config.port}`;

/**
 * A refused password is remembered by a mark of 8 bits, salted: enough to
 * never send the same refused password again by itself after a restart,
 * never enough to find the password (one password in 256 has the same mark).
 */
export function passwordMark(password, salt) {
  return createHash('sha256').update(`${salt}:${password}`, 'utf8').digest()[0];
}
