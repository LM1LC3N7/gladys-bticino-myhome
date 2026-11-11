// -----------------------------------------------------------------------------
// The integration: the event session (what happens on the installation),
// one command session at a time (commands and reads), the model of the
// lights, shutters and heating zones, the Gladys devices and states.
// index.js only wires the SDK handlers to it.
//
// Commands, by kind:
// - protectives (a light or a dimmer off, a shutter stop, a heating zone
//   off): never blocked by an option, a read, the identity check or a queue;
//   they go first, cut a read the gateway leaves silent, cancel the commands
//   of the same target still waiting, are tried again every 250 ms within
//   3.3 s, then kept in /data and sent again when the gateway answers (3
//   times, 10 minutes at most). Refused only when the connection is stopped
//   by a refused password or another gateway, or before any configuration.
// - commands (a light on, a dimmer level, a shutter up, down or to a
//   position): written within 2.5 s or not at all, then read back;
// - thermostats (a set point, the automatic mode): off by default; the
//   option is checked when asked, after the fresh read of the zone, and
//   right before the write; the decision is taken on the zone read just
//   before, never on memory; refused while the zone is being switched off.
// The ack is given within 3.3 s: confirmed (the read back shows the value),
// refused (nothing sent, or the gateway's NACK), or "sent, without
// confirmation" (read again 5 s and 20 s later). The password is never
// logged, never kept.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, passwordMark, placeKey, sessionKey } from './config.js';
import { COVER_STATE, LIMITS, THERMOSTAT_MODE, TIMINGS } from './constants.js';
import { buildDevices, buildStates, parseFeatureId } from './devices.js';
import { CommandLink, EventLink } from './gateway.js';
import { COMMAND_NAMES, T, fill, word } from './i18n.js';
import { FRAMES, decode, digits, parse } from './own/frames.js';
import { OwnSession } from './own/session.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** A command refused before anything was sent (or refused by the gateway). */
export class Refused extends Error {}

const emptyModel = () => ({
  lights: new Map(),
  shutters: new Map(),
  zones: new Map(),
  lightPoints: new Set(),
  shutterPoints: new Set(),
  zoneNumbers: new Set(),
  dimmers: new Set(),
  coarse: new Set(),
  advanced: new Set(),
});

/** A strict 0 / 1 (null, '' and the rest are not 0). */
function binaryOf(value) {
  if (value === 0 || value === '0') return 0;
  if (value === 1 || value === '1') return 1;
  return undefined;
}

/** A finite number from a number or a numeric string; '' and null are not 0. */
function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^\s*-?[0-9]+(\.[0-9]+)?\s*$/.test(value)) return Number(value);
  return undefined;
}

const macOf = (message) => {
  if (message?.kind !== 'dimension' || message.who !== 13 || message.dimension !== '12') {
    return undefined;
  }
  const bytes = message.values.slice(0, 6).map(digits);
  if (bytes.length !== 6 || bytes.some((b) => b === undefined || b > 255)) return undefined;
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
};

export class MyHomeApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'bticino-myhome' }),
    store = fileStore(),
    connect,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    random = randomBytes,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.connectFn = connect;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.random = random;
    this.config = normalizeConfig();
    this.configured = false;
    this.key = undefined;
    this.model = emptyModel();
    this.memory = normalizeMemory(null, now());
    this.memoryState = 'unread';
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.chains = new Map();
    this.timersSet = new Set();
    this.inProgress = new Map();
    this.eventUp = false;
    this.identity = 'unknown';
    this.stopKind = undefined;
    this.started = false;
    this.starting = Promise.resolve();
    this.lastStatus = undefined;
    this.lastDevicesKey = undefined;
    this.lastTransport = undefined;
    this.lastFullRead = undefined;
    this.readOk = false;
    this.reading = undefined;
    this.flushing = false;
    this.publishQueued = false;
    this.closed = false;
    this.command = this.makeCommandLink();
  }

  // --- Small helpers ------------------------------------------------------------

  get language() {
    return this.config.language;
  }

  refused(entry) {
    return new Refused(word(entry, this.language));
  }

  later(fn, ms) {
    const timer = this.timers.setTimeout(() => {
      this.timersSet.delete(timer);
      if (!this.closed) fn();
    }, ms);
    this.timersSet.add(timer);
    return timer;
  }

  /** `promise`, or `fallback` once the monotonic time `until` is passed. */
  within(promise, until, fallback) {
    let timer;
    return Promise.race([
      promise,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(
          () => resolve(fallback),
          Math.max(0, until - this.monotonic()),
        );
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  sleep(ms) {
    return new Promise((resolve) => {
      this.timers.setTimeout(resolve, ms);
    });
  }

  serial(key, fn) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  makeSession(kind) {
    if (!this.config.host) return undefined;
    return new OwnSession({
      host: this.config.host,
      port: this.config.port,
      password: this.config.password,
      kind,
      connect: this.connectFn,
      timers: this.timers,
      monotonic: this.monotonic,
      logger: this.logger,
      random: this.random,
    });
  }

  makeCommandLink() {
    const link = new CommandLink({
      timers: this.timers,
      monotonic: this.monotonic,
      logger: this.logger,
      session: () => this.makeSession('command'),
    });
    link.on('refused', (err) => this.onRefused(err));
    link.on('open', () => {
      if (this.pendingWaiting()) this.later(() => this.flushPending(), 0);
    });
    return link;
  }

  // --- /data ----------------------------------------------------------------------

  async loadMemory() {
    const result = await this.store.load().catch(() => ({ broken: true }));
    if (result.broken) {
      if (this.memoryState !== 'broken') {
        this.logger.warn('/data cannot be read: it is read again every 10 s, never overwritten');
      }
      this.memoryState = 'broken';
      this.later(() => this.retryMemory(), TIMINGS.storeRetry);
      return;
    }
    const loaded = normalizeMemory(result.data ?? null, this.now());
    this.merge(loaded);
    this.memoryState = 'ok';
  }

  async retryMemory() {
    if (this.memoryState !== 'broken') return;
    await this.loadMemory();
    if (this.memoryState === 'ok') {
      this.learnFromMemory();
      await this.saveMemory();
      if (this.pendingWaiting()) this.flushPending();
      await this.refreshStatus();
    }
  }

  /** What the file holds joins what this run already knows (the run wins on a conflict). */
  merge(loaded) {
    const session = this.memory;
    const same = loaded.place === '' || loaded.place === placeKey(this.config);
    const pending = [...session.pending];
    if (same) {
      for (const entry of loaded.pending) {
        if (!pending.some((p) => p.target === entry.target)) pending.push(entry);
      }
    }
    this.memory = {
      version: 1,
      place: placeKey(this.config),
      refused: session.refused ?? (same && !this.everOpen ? loaded.refused : null),
      mac: session.mac ?? (same ? loaded.mac : null),
      pending: pending.slice(0, LIMITS.pendingProtectives),
      lastReadAt: Math.max(session.lastReadAt, same ? loaded.lastReadAt : 0),
      dimmers: [...new Set([...session.dimmers, ...(same ? loaded.dimmers : [])])],
      coarse: [...new Set([...session.coarse, ...(same ? loaded.coarse : [])])],
      advanced: [...new Set([...session.advanced, ...(same ? loaded.advanced : [])])],
    };
  }

  /** Saved when /data was read (an unreadable file is never overwritten); never awaited by a command. */
  saveMemory() {
    if (this.memoryState !== 'ok') return Promise.resolve(false);
    this.memory.place = placeKey(this.config);
    return this.store.save(this.memory).then(
      () => true,
      (err) => {
        this.logger.warn(`Saving the state to /data failed: ${err.message}`);
        return false;
      },
    );
  }

  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = this.later(() => {
      this.saveTimer = undefined;
      this.saveMemory();
    }, 5_000);
  }

  learnFromMemory() {
    for (const point of this.memory.dimmers) this.model.dimmers.add(point);
    for (const point of this.memory.coarse) this.model.coarse.add(point);
    for (const point of this.memory.advanced) this.model.advanced.add(point);
  }

  // --- Lifecycle ------------------------------------------------------------------

  /** Gladys connected (first time or again): the configuration is read, retried every 30 s. */
  async connected() {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.timersSet.delete(this.configTimer);
      this.configTimer = undefined;
    }
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      this.logger.warn(`Reading the configuration failed: ${err.message}; again in 30 s`);
      await this.setStatus(false, T.configUnread);
      this.configTimer = this.later(() => {
        this.configTimer = undefined;
        this.connected();
      }, TIMINGS.configRetry);
      return;
    }
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    // Gladys restarted: it lost the status, the discovered devices, the states.
    const status = this.lastStatus;
    this.lastStatus = undefined;
    this.lastDevicesKey = undefined;
    this.lastTransport = undefined;
    this.publisher.forget();
    await this.configUpdated(raw);
    if (this.lastStatus === undefined && status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishAll();
  }

  /** Starts (or restarts); two starts never overlap. */
  start(raw = {}) {
    const run = this.starting.then(() => this.startNow(raw));
    this.starting = run.catch(() => undefined);
    return run;
  }

  async startNow(raw) {
    this.stopLinks();
    const next = normalizeConfig(raw);
    if (placeKey(next) !== placeKey(this.config)) {
      // Another gateway, maybe: what we knew no longer holds.
      this.model = emptyModel();
      this.memory = normalizeMemory(null, this.now());
      this.memoryState = 'unread';
      this.everOpen = false;
    }
    this.config = next;
    this.configured = true;
    this.key = sessionKey(next);
    this.stopKind = undefined;
    this.identity = 'unknown';
    this.closed = false;
    if (next.errors.length > 0) {
      this.logger.warn(`${next.errors.length} configuration entries not understood (ignored)`);
    }
    if (this.memoryState !== 'ok') await this.loadMemory();
    this.learnFromMemory();
    this.seedModel();
    await this.publishDevices();
    await this.publishStates();
    if (!next.host) {
      await this.setStatus(false, T.noHost);
      return;
    }
    if (next.passwordInvalid) {
      await this.setStatus(false, T.badPassword);
      return;
    }
    const refused = this.memory.refused;
    if (refused && passwordMark(next.password, refused.salt) === refused.mark) {
      this.stopKind = 'refused';
      this.logger.warn(
        'OpenWebNet: the gateway refused this password before: no connection until it changes or "Test the connection" is clicked',
      );
      await this.setStatus(false, T.refused);
      return;
    }
    this.command.resume();
    await this.setStatus(false, T.connecting);
    this.startEvents();
    if (this.pendingWaiting()) this.flushPending();
    this.startSweeper();
  }

  /** The config points and zones, and the devices the user created, are in the model from the start. */
  seedModel() {
    const { model, config } = this;
    for (const point of [...config.dimmers, ...config.readOnly]) model.lightPoints.add(point);
    for (const point of config.dimmers) model.dimmers.add(point);
    for (const zone of config.zones) model.zoneNumbers.add(zone);
    for (const device of this.gladys.devices ?? []) {
      const target = parseFeatureId(this.gladys, `${device?.external_id}:x`);
      if (target?.kind === 'light') model.lightPoints.add(target.point);
      if (target?.kind === 'shutter') model.shutterPoints.add(target.point);
      if (target?.kind === 'zone') model.zoneNumbers.add(target.zone);
      // A feature the user created tells the kind learnt before.
      const keys = (device?.features ?? []).map((f) =>
        String(f?.external_id ?? '')
          .split(':')
          .at(-1),
      );
      if (target?.kind === 'light' && keys.includes('brightness')) model.dimmers.add(target.point);
      if (target?.kind === 'shutter' && keys.includes('position')) model.advanced.add(target.point);
    }
  }

  startEvents() {
    if (this.events) {
      this.events.stop();
      this.events.removeAllListeners();
    }
    const events = new EventLink({
      timers: this.timers,
      monotonic: this.monotonic,
      logger: this.logger,
      session: () => this.makeSession('event'),
    });
    events.on('up', () => this.onEventUp());
    events.on('down', (info) => this.onEventDown(info));
    events.on('refused', (err) => this.onRefused(err));
    events.on('frame', (frame) => this.onFrame(frame, 'event'));
    this.events = events;
    events.start();
  }

  startSweeper() {
    if (this.sweeper) this.timers.clearInterval(this.sweeper);
    this.sweeper = this.timers.setInterval(() => this.publishStates(), TIMINGS.sweep);
  }

  stopLinks() {
    if (this.events) {
      this.events.stop();
      this.events.removeAllListeners();
      this.events = undefined;
    }
    this.command.stop();
    this.eventUp = false;
    this.identity = 'unknown';
    this.readOk = false;
    if (this.readTimer) {
      this.timers.clearTimeout(this.readTimer);
      this.timersSet.delete(this.readTimer);
      this.readTimer = undefined;
    }
  }

  /** Clean stop (the container stops): every timer and socket closed, /data written. */
  async stop() {
    this.closed = true;
    this.stopLinks();
    if (this.sweeper) this.timers.clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const timer of this.timersSet) this.timers.clearTimeout(timer);
    this.timersSet.clear();
    this.saveTimer = undefined;
    this.configTimer = undefined;
    this.publisher.stop();
    await this.saveMemory();
  }

  /** A new place or password reconnects (and lifts a stop); the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    if (sessionKey(next) !== this.key) {
      // The thermostat option holds at once, even while the restart waits.
      this.config = { ...this.config, allowThermostat: next.allowThermostat };
      if (this.memory.refused) {
        this.memory.refused = null;
        this.saveMemory();
      }
      return this.start(raw);
    }
    this.config = { ...next };
    this.seedModel();
    await this.publishDevices();
    await this.publishStates();
    await this.refreshStatus();
    return undefined;
  }

  // --- Links ------------------------------------------------------------------------

  async onRefused(err) {
    if (this.stopKind) return;
    const kind = err.kind === 'passwordInvalid' ? 'passwordDigits' : err.kind;
    this.stopKind = kind;
    this.stopLinks();
    this.logger.error(`OpenWebNet: ${err.message}: connection stopped`);
    if (err.kind === 'refused') {
      const salt = this.random(8).toString('hex');
      this.memory.refused = {
        mark: passwordMark(this.config.password, salt),
        salt,
        kind: 'refused',
      };
      this.saveMemory();
    }
    await this.setStatus(false, this.stopMessage());
    await this.publishTransports();
  }

  stopMessage() {
    if (this.stopKind === 'otherGateway') {
      return fill(T.otherGateway, this.seenMac ?? '?', this.memory.mac ?? '?');
    }
    return T[this.stopKind] ?? T.refused;
  }

  async onEventUp() {
    this.eventUp = true;
    this.everOpen = true;
    this.identity = 'unknown';
    if (this.memory.refused) {
      this.memory.refused = null;
      this.saveMemory();
    }
    this.logger.info('OpenWebNet event session open');
    await this.setStatus(false, T.reading);
    await this.publishTransports();
    if (this.pendingWaiting()) this.flushPending();
    this.scheduleRead(0);
  }

  async onEventDown({ reason, retryIn, stopped }) {
    this.eventUp = false;
    this.readOk = false;
    if (stopped || this.stopKind) return;
    this.logger.warn(`OpenWebNet event session down (${reason}), next try in ${retryIn} ms`);
    await this.setStatus(false, fill(T.offline, Math.round((retryIn ?? 0) / 1000)));
    await this.publishTransports();
  }

  // --- Frames -----------------------------------------------------------------------

  onFrame(frame, source) {
    const message = parse(frame);
    const update = decode(message);
    if (!update) return undefined;
    const changed = this.apply(update, source);
    this.queuePublish();
    return changed;
  }

  /** One decoded update into the model. `source`: event (the monitor) or read. */
  apply(update, source) {
    const { model } = this;
    const at = this.monotonic();
    if (update.who === 1) {
      const { point } = update;
      if (!model.lightPoints.has(point)) {
        if (model.lightPoints.size >= LIMITS.points) return undefined;
        this.devicesChanged();
      }
      model.lightPoints.add(point);
      if (update.dimmer && !model.dimmers.has(point)) {
        model.dimmers.add(point);
        this.memory.dimmers = [...model.dimmers].slice(0, LIMITS.points);
        this.saveSoon();
        this.devicesChanged();
      }
      if (update.coarse !== undefined && update.coarse !== model.coarse.has(point)) {
        if (update.coarse) model.coarse.add(point);
        else model.coarse.delete(point);
        this.memory.coarse = [...model.coarse].slice(0, LIMITS.points);
        this.saveSoon();
      }
      const state = model.lights.get(point) ?? {};
      state.on = update.on;
      if (update.level !== undefined) state.level = update.level;
      else if (update.on && !(state.level > 0)) delete state.level;
      state.at = at;
      model.lights.set(point, state);
      if (source === 'event') this.spontaneous(`light:${point}`);
      return `light:${point}`;
    }
    if (update.who === 2) {
      const { point } = update;
      if (!model.shutterPoints.has(point) && model.shutterPoints.size >= LIMITS.points) {
        return undefined;
      }
      if (!model.shutterPoints.has(point)) this.devicesChanged();
      model.shutterPoints.add(point);
      if (update.advanced && !model.advanced.has(point)) {
        model.advanced.add(point);
        this.memory.advanced = [...model.advanced].slice(0, LIMITS.points);
        this.saveSoon();
        this.devicesChanged();
      }
      const state = model.shutters.get(point) ?? {};
      state.motion = update.motion;
      state.at = at;
      if (update.position !== undefined) {
        state.position = update.position;
        state.positionAt = at;
      }
      model.shutters.set(point, state);
      if (source === 'event') this.spontaneous(`shutter:${point}`);
      return `shutter:${point}`;
    }
    if (update.who === 4) {
      const { zone } = update;
      if (!model.zoneNumbers.has(zone)) {
        if (model.zoneNumbers.size >= LIMITS.zones) return undefined;
        model.zoneNumbers.add(zone);
        this.devicesChanged();
      }
      const state = model.zones.get(zone) ?? {};
      if (update.temperature !== undefined) {
        state.temperature = update.temperature;
        state.temperatureAt = at;
      }
      if (update.setpoint !== undefined) {
        state.setpoint = update.setpoint;
        state.setpointAt = at;
      }
      if (update.mode !== undefined) {
        state.mode = update.mode;
        state.modeAt = at;
      }
      if (update.season !== undefined) state.season = update.season;
      model.zones.set(zone, state);
      if (source === 'event' && update.mode !== undefined) this.spontaneous(`zone:${zone}`);
      return `zone:${zone}`;
    }
    return undefined;
  }

  /**
   * Something happened to a target on the installation (a button, the app, a
   * stop reached): a protective kept for later is dropped, the target is not
   * stopped again behind the back of whoever moved it.
   */
  spontaneous(target) {
    const index = this.memory.pending.findIndex((p) => p.target === target);
    if (index === -1 || this.inProgress.has(target)) return;
    this.memory.pending.splice(index, 1);
    this.logger.info(`Protective for ${target} dropped: the device changed on the installation`);
    this.saveMemory();
  }

  devicesChanged() {
    this.devicesDirty = true;
  }

  queuePublish() {
    if (this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      if (this.closed) return;
      if (this.devicesDirty) {
        this.devicesDirty = false;
        this.publishDevices().catch(() => undefined);
      }
      this.publishStates();
    });
  }

  // --- Gladys -----------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  connectedMessage() {
    const { model } = this;
    const extras = [];
    if (this.config.errors.length > 0) extras.push(fill(T.configErrors, this.config.errors.length));
    if (this.memoryState === 'broken') extras.push(T.dataBroken);
    const extra = (lang) => extras.map((e) => word(e, lang)).join('');
    return {
      en: word(T.connected, 'en')(
        model.lightPoints.size,
        model.shutterPoints.size,
        model.zoneNumbers.size,
        extra('en'),
      ),
      fr: word(T.connected, 'fr')(
        model.lightPoints.size,
        model.shutterPoints.size,
        model.zoneNumbers.size,
        extra('fr'),
      ),
    };
  }

  async refreshStatus() {
    if (!this.configured) return;
    if (this.stopKind) return this.setStatus(false, this.stopMessage());
    if (!this.config.host) return this.setStatus(false, T.noHost);
    if (this.config.passwordInvalid) return this.setStatus(false, T.badPassword);
    if (this.eventUp && this.readOk) return this.setStatus(true, this.connectedMessage());
    if (this.eventUp) return this.setStatus(false, this.reading ? T.reading : T.readFailed);
    return undefined;
  }

  devicesKey(devices) {
    return JSON.stringify(
      devices.map((d) => [d.external_id, d.features.map((f) => f.external_id)]),
    );
  }

  async publishDevices({ force = false } = {}) {
    if (!this.configured) return;
    const devices = buildDevices(this.gladys, this.config, this.model);
    const key = JSON.stringify([this.devicesKey(devices), this.language]);
    if (!force && key === this.lastDevicesKey) return;
    this.lastDevicesKey = key;
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) => this.logger.warn(`Publishing the devices failed: ${err.message}`));
  }

  /** The states of the features the user created, fresh only. */
  publishStates() {
    if (!this.configured) return Promise.resolve();
    const created = new Set();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device?.features ?? []) created.add(feature?.external_id);
    }
    const states = buildStates(this.gladys, this.config, this.model, this.monotonic()).filter((s) =>
      created.has(s.device_feature_external_id),
    );
    return this.publisher.publish(states);
  }

  async publishTransports() {
    const transport =
      this.eventUp && !this.stopKind ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
    const ids = (this.gladys.devices ?? [])
      .map((d) => d?.external_id)
      .filter((id) => typeof id === 'string' && id.startsWith(this.gladys.externalId('')));
    const key = JSON.stringify([transport, ids]);
    if (key === this.lastTransport || ids.length === 0) return;
    this.lastTransport = key;
    for (let i = 0; i < ids.length; i += 100) {
      await this.gladys
        .publishTransports(
          ids.slice(i, i + 100).map((id) => ({ device_external_id: id, transport })),
        )
        .catch((err) => this.logger.warn(`Publishing the transports failed: ${err.message}`));
    }
  }

  async publishAll() {
    await this.publishDevices({ force: true });
    await this.publishStates();
    await this.publishTransports();
  }

  /** A device created or updated by the user: its states again, and its address in the model. */
  async deviceChanged(device) {
    if (typeof device?.external_id !== 'string') return;
    this.publisher.forget(device.external_id);
    const target = parseFeatureId(this.gladys, `${device.external_id}:x`);
    if (target?.kind === 'light') this.model.lightPoints.add(target.point);
    if (target?.kind === 'shutter') this.model.shutterPoints.add(target.point);
    if (target?.kind === 'zone') this.model.zoneNumbers.add(target.zone);
    this.lastTransport = undefined;
    await this.publishStates();
    await this.publishTransports();
  }

  // --- Reads ----------------------------------------------------------------------------

  /** A full read in `ms`, never sooner than TIMINGS.readGap after the last one (this run or /data). */
  scheduleRead(ms) {
    if (this.readTimer) {
      this.timers.clearTimeout(this.readTimer);
      this.timersSet.delete(this.readTimer);
    }
    const mono = this.monotonic();
    let earliest = mono + ms;
    if (this.lastFullRead !== undefined) {
      earliest = Math.max(earliest, this.lastFullRead + TIMINGS.readGap);
    } else if (this.memory.lastReadAt > 0) {
      const since = this.now() - this.memory.lastReadAt;
      if (since >= 0 && since < TIMINGS.readGap)
        earliest = Math.max(earliest, mono + TIMINGS.readGap - since);
    }
    this.readTimer = this.later(
      () => {
        this.readTimer = undefined;
        this.fullRead();
      },
      Math.max(0, earliest - mono),
    );
  }

  /** A read request; resolves with its decoded frames, or undefined (no answer, NACK). */
  async read(frame, { kind = 'read', target, sendBy, timeout } = {}) {
    try {
      const answer = await this.command.submit({ frame, kind, target, sendBy, timeout });
      if (!answer.ack) return { nack: true, frames: answer.frames };
      for (const message of answer.frames) {
        const update = decode(message);
        if (update) this.apply(update, 'read');
      }
      this.queuePublish();
      return { frames: answer.frames };
    } catch (err) {
      return { error: err };
    }
  }

  async fullRead() {
    if (this.reading || this.stopKind || !this.eventUp) return this.reading;
    const run = (async () => {
      this.lastFullRead = this.monotonic();
      this.memory.lastReadAt = this.now();
      // The time of the try is in /data before the read (a restart never reads sooner).
      await this.saveMemory();
      if (this.pendingWaiting()) await this.flushPending();
      await this.readIdentity();
      if (this.stopKind) return;
      const frames = [FRAMES.allLights, FRAMES.allShutters];
      for (const point of [...this.model.dimmers]) {
        if (this.model.lightPoints.has(point)) frames.push(FRAMES.dimmerLevel(point));
      }
      for (const point of [...this.model.advanced]) frames.push(FRAMES.shutterAdvanced(point));
      for (const zone of [...this.model.zoneNumbers]) {
        frames.push(
          FRAMES.zoneTemperature(zone),
          FRAMES.zoneSetpoint(zone),
          FRAMES.zoneStatus(zone),
        );
      }
      const results = [];
      for (const frame of frames) {
        if (this.stopKind || this.closed) break;
        const result = await this.read(frame);
        results.push(result);
        // The gateway does not answer: the rest waits for the next cycle.
        if (result.error && !result.error.sent) break;
      }
      // Connected only on an answer of the gateway (an ACK or a NACK to a status request).
      this.readOk = results.some((r) => !r.error);
    })();
    this.reading = run.finally(async () => {
      this.reading = undefined;
      if (this.closed) return;
      await this.publishDevices();
      await this.publishStates();
      await this.refreshStatus();
      if (this.eventUp && !this.stopKind) this.scheduleRead(TIMINGS.fullRead);
    });
    await this.refreshStatus();
    return this.reading;
  }

  /** The MAC of the gateway, once per event session: another gateway at the address stops everything. */
  async readIdentity(sendBy) {
    if (this.identity === 'ok' || this.identity === 'unsupported') return this.identity;
    const result = await this.read(FRAMES.mac, {
      kind: sendBy === undefined ? 'read' : 'command',
      sendBy,
      timeout:
        sendBy === undefined ? TIMINGS.readTimeout : Math.max(200, sendBy - this.monotonic()),
    });
    const mac = (result.frames ?? []).map(macOf).find(Boolean);
    if (mac) {
      if (this.memory.mac && this.memory.mac !== mac) {
        this.seenMac = mac;
        this.logger.error(
          `OpenWebNet: another gateway at this address (MAC ${mac}, known ${this.memory.mac})`,
        );
        await this.onRefused({ kind: 'otherGateway', message: 'Another gateway at this address' });
        return 'mismatch';
      }
      if (!this.memory.mac) {
        this.memory.mac = mac;
        this.saveMemory();
      }
      this.identity = 'ok';
    } else if (result.nack && !this.memory.mac) {
      // A gateway that does not give its MAC: nothing to compare.
      this.identity = 'unsupported';
    } else {
      this.identity = 'unknown';
    }
    return this.identity;
  }

  scheduleReadBacks(target, frame) {
    for (const delay of TIMINGS.readBacks) {
      this.later(() => {
        if (this.stopKind) return;
        this.read(frame, { target }).then(() => this.publishStates());
      }, delay);
    }
  }

  // --- Commands -------------------------------------------------------------------------

  async setValue(_device, feature, value) {
    const target = parseFeatureId(this.gladys, feature?.external_id);
    if (!target) throw new Error(`${feature?.external_id} is not a feature of this integration`);
    const asked = this.monotonic();
    if (target.kind === 'light') return this.lightCommand(target, value, asked);
    if (target.kind === 'shutter') return this.shutterCommand(target, value, asked);
    return this.zoneCommand(target, value, asked);
  }

  lightCommand({ point, key }, value, asked) {
    const id = point;
    if (key === 'readonly' || this.config.readOnly.includes(point)) {
      this.logger.warn(`Light ${id} REFUSED: read only in the configuration`);
      throw this.refused(T.readOnly);
    }
    const off = () =>
      this.protective({
        kind: 'lightOff',
        target: `light:${point}`,
        frame: FRAMES.lightOff(point),
        readFrame: FRAMES.lightStatus(point),
        confirm: (s) => s.who === 1 && s.point === point && s.on === false,
        contradicted: (s) => s.who === 1 && s.point === point && s.on === true,
        what: fill(COMMAND_NAMES.lightOff, id),
        asked,
      });
    if (key === 'binary') {
      const on = binaryOf(value);
      if (on === undefined) throw this.refused(T.badValue);
      if (on === 0) return off();
      return this.normal({
        target: `light:${point}`,
        frame: FRAMES.lightOn(point),
        readFrame: FRAMES.lightStatus(point),
        confirm: (s) => s.who === 1 && s.point === point && s.on === true,
        what: fill(COMMAND_NAMES.lightOn, id),
        asked,
      });
    }
    if (key === 'brightness') {
      const number = numberOf(value);
      if (number === undefined || number < 0 || number > 100) throw this.refused(T.badValue);
      const level = Math.round(number);
      if (level === 0) return off();
      const coarse = this.model.coarse.has(point);
      return this.normal({
        target: `light:${point}`,
        frame: coarse ? FRAMES.dimmerPreset(point, level) : FRAMES.dimmerSet(point, level),
        readFrame: FRAMES.dimmerLevel(point),
        // A coarse dimmer lands on its own steps: on is enough.
        confirm: (s) =>
          s.who === 1 &&
          s.point === point &&
          s.on === true &&
          (coarse || (s.level !== undefined && Math.abs(s.level - level) <= 1)),
        what: fill(COMMAND_NAMES.dimmer, id, level),
        asked,
      });
    }
    throw new Error(`${key} is read only`);
  }

  shutterCommand({ point, key }, value, asked) {
    const id = point;
    const mine = (s) => s.who === 2 && s.point === point;
    if (key === 'state') {
      const state = numberOf(value);
      if (state === COVER_STATE.STOP) {
        return this.protective({
          kind: 'shutterStop',
          target: `shutter:${point}`,
          frame: FRAMES.shutterStop(point),
          readFrame: FRAMES.shutterStatus(point),
          confirm: (s) => mine(s) && s.motion === 'stopped',
          contradicted: (s) => mine(s) && s.motion !== 'stopped',
          what: fill(COMMAND_NAMES.shutterStop, id),
          asked,
        });
      }
      if (state === COVER_STATE.OPEN || state === COVER_STATE.CLOSE) {
        const up = state === COVER_STATE.OPEN;
        return this.normal({
          target: `shutter:${point}`,
          frame: up ? FRAMES.shutterUp(point) : FRAMES.shutterDown(point),
          readFrame: FRAMES.shutterStatus(point),
          confirm: (s) => mine(s) && s.motion === (up ? 'up' : 'down'),
          what: fill(up ? COMMAND_NAMES.shutterUp : COMMAND_NAMES.shutterDown, id),
          asked,
        });
      }
      throw this.refused(T.badValue);
    }
    if (key === 'position') {
      const number = numberOf(value);
      if (number === undefined || number < 0 || number > 100) throw this.refused(T.badValue);
      const position = Math.round(number);
      return this.normal({
        target: `shutter:${point}`,
        frame: FRAMES.shutterPosition(point, position),
        readFrame: FRAMES.shutterAdvanced(point),
        // Moving, or already within 2 % of the position.
        confirm: (s) =>
          mine(s) &&
          (s.motion !== 'stopped' ||
            (s.position !== undefined && Math.abs(s.position - position) <= 2)),
        what: fill(COMMAND_NAMES.shutterPosition, id, position),
        asked,
      });
    }
    throw new Error(`${key} is read only`);
  }

  zoneCommand({ zone, key }, value, asked) {
    const plant = this.config.plant;
    if (key === 'mode') {
      const mode = numberOf(value);
      if (mode === THERMOSTAT_MODE.OFF) {
        return this.protective({
          kind: 'zoneOff',
          target: `zone:${zone}`,
          frame: FRAMES.zoneOff(zone, plant),
          readFrame: FRAMES.zoneStatus(zone),
          confirm: (s) => s.who === 4 && s.zone === zone && s.mode === 'off',
          contradicted: () => false,
          what: fill(COMMAND_NAMES.zoneOff, zone),
          asked,
        });
      }
      if (mode === THERMOSTAT_MODE.AUTO) {
        if (plant === 'standalone') throw this.refused(T.autoStandalone);
        return this.sensitive({
          zone,
          what: fill(COMMAND_NAMES.zoneAuto, zone),
          asked,
          freshFrame: FRAMES.zoneStatus(zone),
          fresh: (s) => s.mode,
          already: (mode) => mode === 'auto',
          frame: FRAMES.zoneAuto(zone),
          confirm: (s) => s.who === 4 && s.zone === zone && s.mode === 'auto',
        });
      }
      if (mode === THERMOSTAT_MODE.HEATING || mode === THERMOSTAT_MODE.COOLING) {
        throw this.refused(T.modeUnsupported);
      }
      throw this.refused(T.badValue);
    }
    if (key === 'target') {
      const number = numberOf(value);
      if (number === undefined) throw this.refused(T.badValue);
      if (number < LIMITS.minSetpoint || number > LIMITS.maxSetpoint) {
        throw this.refused(fill(T.setpointRange, LIMITS.minSetpoint, LIMITS.maxSetpoint));
      }
      // Half degrees, as the thermostats take them; the bounds hold after rounding.
      const degrees = Math.min(
        LIMITS.maxSetpoint,
        Math.max(LIMITS.minSetpoint, Math.round(number * 2) / 2),
      );
      return this.sensitive({
        zone,
        what: fill(COMMAND_NAMES.setpoint, zone, degrees),
        asked,
        freshFrame: FRAMES.zoneSetpoint(zone),
        fresh: (s) => s.setpoint,
        already: (setpoint) => setpoint === degrees,
        frame: FRAMES.zoneSetpointSet(zone, degrees, plant),
        confirm: (s) => s.who === 4 && s.zone === zone && s.setpoint === degrees,
      });
    }
    throw new Error(`${key} is read only`);
  }

  /** The reason a command was not sent, as the user reads it. */
  notSent(err) {
    if (err?.kind === 'late') return this.refused(T.tooLate);
    if (err?.kind === 'full') return this.refused(T.queueFull);
    if (err?.kind === 'replaced') return this.refused(T.replaced);
    if (err?.kind === 'withdrawn') return this.refused(T.thermostatDisabled);
    if (this.stopKind) return this.refused(T.stopped);
    return this.refused(T.offlineCommand);
  }

  unconfirmed(what, target, readFrame) {
    this.logger.warn(`Command sent, NOT confirmed (${word(what, 'en')})`);
    this.scheduleReadBacks(target, readFrame);
    return new Error(word(fill(T.unconfirmed, word(what, this.language)), this.language));
  }

  /** A newer command of the target left: a protective kept for later is not sent again. */
  noteWritten(target) {
    const index = this.memory.pending.findIndex((p) => p.target === target);
    if (index === -1) return;
    this.memory.pending.splice(index, 1);
    this.saveMemory();
  }

  /** The read back after an ACK: the decoded updates of the target, or undefined. */
  async readBack(readFrame, target, kind) {
    const result = await this.read(readFrame, { kind, target, timeout: TIMINGS.readTimeout });
    if (result.error || result.nack) return undefined;
    return result.frames.map(decode).filter(Boolean);
  }

  checkCommandable() {
    if (!this.configured || !this.config.host) throw this.refused(T.notConfigured);
    if (this.stopKind) throw this.refused(T.stopped);
  }

  async checkIdentity(asked) {
    if (this.identity === 'ok' || this.identity === 'unsupported') return;
    const identity = await this.readIdentity(asked + TIMINGS.sendBy);
    if (identity !== 'ok' && identity !== 'unsupported') {
      throw this.refused(this.stopKind ? T.stopped : T.identityUnknown);
    }
  }

  /** A command (not protective, not a thermostat): written by `sendBy`, read back. */
  async normal({ target, frame, readFrame, confirm, what, asked }) {
    this.checkCommandable();
    await this.checkIdentity(asked);
    this.logger.info(`Command from Gladys: ${word(what, 'en')}`);
    let written = false;
    const work = this.serial(target, async () => {
      let answer;
      try {
        answer = await this.command.submit({
          frame,
          kind: 'command',
          target,
          sendBy: asked + TIMINGS.sendBy,
          timeout: Math.max(200, asked + TIMINGS.answerBy - this.monotonic()),
          onWritten: () => {
            written = true;
            this.noteWritten(target);
          },
        });
      } catch (err) {
        if (!err.sent) throw this.notSent(err);
        throw this.unconfirmed(what, target, readFrame);
      }
      if (!answer.ack) {
        this.logger.warn(`Command refused by the gateway (${word(what, 'en')})`);
        throw this.refused(T.gatewayRefused);
      }
      const updates = await this.readBack(readFrame, target, 'command');
      if (updates?.some(confirm)) {
        this.logger.info(`Command confirmed (${word(what, 'en')})`);
        return;
      }
      throw this.unconfirmed(what, target, readFrame);
    });
    work.catch(() => undefined);
    const outcome = await this.within(
      work.then(
        () => ({ ok: true }),
        (err) => ({ err }),
      ),
      asked + TIMINGS.answerBy,
      { late: true },
    );
    if (outcome.ok) return undefined;
    if (outcome.err) throw outcome.err;
    // Not written by now: it never will be (sendBy is before answerBy).
    if (!written) throw this.refused(T.tooLate);
    // On its way: never "not sent" once it left.
    throw new Error(word(fill(T.unconfirmed, word(what, this.language)), this.language));
  }

  // --- Protectives ----------------------------------------------------------------------

  pendingWaiting() {
    return this.memory.pending.length > 0;
  }

  keepPending(entry) {
    const pending = this.memory.pending.filter((p) => p.target !== entry.target);
    pending.push(entry);
    this.memory.pending = pending.slice(-LIMITS.pendingProtectives);
    this.saveMemory();
  }

  dropPending(target, at) {
    const index = this.memory.pending.findIndex((p) => p.target === target && p.at <= at);
    if (index === -1) return;
    this.memory.pending.splice(index, 1);
    this.saveMemory();
  }

  /**
   * A protective: first in line, tried again every 250 ms within its budget,
   * kept in /data (from the click) until it is written.
   */
  async protective({ kind, target, frame, readFrame, confirm, contradicted, what, asked }) {
    if (!this.configured || !this.config.host) throw this.refused(T.notConfigured);
    if (this.stopKind) throw this.refused(T.stopped);
    this.logger.info(`PROTECTIVE from Gladys: ${word(what, 'en')}`);
    const wall = this.now();
    const token = {};
    this.inProgress.set(target, token);
    this.keepPending({ kind, target, frame, at: wall, tries: 0 });
    const until = asked + TIMINGS.protectiveBudget;
    let resent = false;
    try {
      for (;;) {
        let answer;
        try {
          answer = await this.command.submit({ frame, kind: 'protective', target, sendBy: until });
        } catch (err) {
          if (err.sent) {
            this.dropPending(target, wall);
            throw this.unconfirmed(what, target, readFrame);
          }
          if (this.stopKind) throw this.refused(T.stopped);
          if (this.monotonic() + TIMINGS.protectiveRetry > until) break;
          await this.sleep(TIMINGS.protectiveRetry);
          continue;
        }
        this.dropPending(target, wall);
        if (!answer.ack) {
          // NACK: the gateway did not put it on the bus. Again, within the budget.
          this.logger.warn(`Protective refused by the gateway (${word(what, 'en')})`);
          if (this.monotonic() + TIMINGS.protectiveRetry > until)
            throw this.refused(T.gatewayRefused);
          this.keepPending({ kind, target, frame, at: wall, tries: 0 });
          await this.sleep(TIMINGS.protectiveRetry);
          continue;
        }
        const updates = await this.readBack(readFrame, target, 'protective');
        if (updates?.some(confirm)) {
          this.logger.info(`Protective confirmed (${word(what, 'en')})`);
          return undefined;
        }
        // Contradicted by a read that left after it: sent once more, within the budget.
        if (!resent && updates?.some(contradicted) && this.monotonic() < until) {
          resent = true;
          this.logger.warn(
            `Protective contradicted by the read back, sent again (${word(what, 'en')})`,
          );
          continue;
        }
        throw this.unconfirmed(what, target, readFrame);
      }
      this.logger.warn(`Protective NOT sent in time, kept for later (${word(what, 'en')})`);
      this.ensurePendingTimer();
      throw new Refused(word(fill(T.keptForLater, word(what, this.language)), this.language));
    } finally {
      if (this.inProgress.get(target) === token) this.inProgress.delete(target);
    }
  }

  ensurePendingTimer() {
    if (this.pendingTimer) return;
    this.pendingTimer = this.later(() => {
      this.pendingTimer = undefined;
      if (this.pendingWaiting()) {
        this.flushPending();
        this.ensurePendingTimer();
      }
    }, 30_000);
  }

  /** The protectives kept for later: sent again (3 times, 10 minutes at most). */
  async flushPending() {
    if (this.flushing || this.stopKind || !this.config.host || this.closed) return;
    this.flushing = true;
    try {
      const wall = this.now();
      const kept = this.memory.pending.filter(
        (p) =>
          wall - p.at <= TIMINGS.protectiveKeep && p.at <= wall && p.tries < LIMITS.protectiveTries,
      );
      if (kept.length !== this.memory.pending.length) {
        this.memory.pending = kept;
        this.saveMemory();
      }
      for (const entry of [...kept]) {
        if (this.inProgress.has(entry.target) || this.stopKind) continue;
        if (!this.memory.pending.includes(entry)) continue;
        entry.tries += 1;
        this.saveMemory();
        this.logger.info(
          `Protective kept for later sent again (${entry.kind} ${entry.target}, try ${entry.tries})`,
        );
        try {
          const answer = await this.command.submit({
            frame: entry.frame,
            kind: 'protective',
            target: entry.target,
            sendBy: this.monotonic() + TIMINGS.protectiveBudget,
          });
          if (answer.ack) this.dropPending(entry.target, entry.at);
        } catch (err) {
          if (err.sent) this.dropPending(entry.target, entry.at);
          else break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  // --- Thermostats ------------------------------------------------------------------------

  allowed() {
    return this.config.allowThermostat === true;
  }

  checkAllowed(what) {
    if (this.allowed()) return;
    this.logger.warn(
      `Thermostat command REFUSED (${word(what, 'en')}): disabled in the configuration`,
    );
    throw this.refused(T.thermostatDisabled);
  }

  stopping(zone) {
    const target = `zone:${zone}`;
    return this.inProgress.has(target) || this.memory.pending.some((p) => p.target === target);
  }

  async sensitive({ zone, what, asked, freshFrame, fresh, already, frame, confirm }) {
    this.checkAllowed(what);
    this.checkCommandable();
    if (this.stopping(zone)) throw this.refused(T.zoneStopping);
    await this.checkIdentity(asked);
    const target = `zone:${zone}`;
    let written = false;
    const work = this.serial(target, async () => {
      this.checkAllowed(what);
      if (this.stopping(zone)) throw this.refused(T.zoneStopping);
      const sendBy = asked + TIMINGS.sendBy;
      // The zone read now: a frame of this answer, never the memory.
      const result = await this.read(freshFrame, {
        kind: 'command',
        target,
        sendBy,
        timeout: Math.max(200, Math.min(TIMINGS.readBefore, sendBy - this.monotonic())),
      });
      if (result.error && !result.error.sent) throw this.notSent(result.error);
      const updates = (result.frames ?? [])
        .map(decode)
        .filter((s) => s?.who === 4 && s.zone === zone);
      const value = updates.map(fresh).find((v) => v !== undefined);
      if (value === undefined) throw this.refused(T.zoneUnknown);
      if (already(value)) {
        this.logger.info(`Zone ${zone} already as asked: nothing sent (${word(what, 'en')})`);
        return;
      }
      this.checkAllowed(what);
      if (this.stopping(zone)) throw this.refused(T.zoneStopping);
      this.logger.info(`THERMOSTAT from Gladys: ${word(what, 'en')}`);
      let answer;
      try {
        answer = await this.command.submit({
          frame,
          kind: 'command',
          target,
          sendBy,
          timeout: Math.max(200, asked + TIMINGS.answerBy - this.monotonic()),
          check: () => this.allowed() && !this.stopping(zone),
          onWritten: () => {
            written = true;
          },
        });
      } catch (err) {
        if (!err.sent) throw this.notSent(err);
        throw this.unconfirmed(what, target, freshFrame);
      }
      if (!answer.ack) throw this.refused(T.gatewayRefused);
      const back = await this.readBack(freshFrame, target, 'command');
      if (back?.some(confirm)) return;
      throw this.unconfirmed(what, target, freshFrame);
    });
    work.catch(() => undefined);
    const outcome = await this.within(
      work.then(
        () => ({ ok: true }),
        (err) => ({ err }),
      ),
      asked + TIMINGS.answerBy,
      { late: true },
    );
    if (outcome.ok) return undefined;
    if (outcome.err) throw outcome.err;
    if (!written) throw this.refused(T.tooLate);
    throw new Error(word(fill(T.unconfirmed, word(what, this.language)), this.language));
  }

  // --- Configuration screen ------------------------------------------------------------------

  /** "Scan": the installation read again (never sooner than the gap), the devices published. */
  async scan() {
    if (this.eventUp && !this.stopKind) {
      if (
        this.lastFullRead === undefined ||
        this.monotonic() - this.lastFullRead >= TIMINGS.readGap
      ) {
        await this.fullRead();
      }
    }
    await this.publishDevices({ force: true });
  }

  /** Waits for the event session to come up or fail, at most `ms`. */
  waitForLink(ms) {
    if (this.eventUp) return Promise.resolve('up');
    const events = this.events;
    if (!events) return Promise.resolve('down');
    return new Promise((resolve) => {
      const done = (result) => {
        events.off('up', onUp);
        events.off('down', onDown);
        events.off('refused', onDown);
        this.timers.clearTimeout(timer);
        resolve(result);
      };
      const onUp = () => done('up');
      const onDown = () => done('down');
      const timer = this.timers.setTimeout(() => done('timeout'), ms);
      events.on('up', onUp);
      events.on('down', onDown);
      events.on('refused', onDown);
    });
  }

  /**
   * "Test the connection": lifts a stop (refused password, another gateway:
   * the MAC is learnt again), connects when no session is open, tells what
   * was read.
   */
  async testConnection() {
    if (!this.configured || !this.config.host) throw new Error(word(T.noHost, this.language));
    if (this.config.passwordInvalid) throw new Error(word(T.badPassword, this.language));
    if (this.stopKind || !this.eventUp) {
      if (this.stopKind === 'otherGateway') this.memory.mac = null;
      this.memory.refused = null;
      this.saveMemory();
      this.stopKind = undefined;
      this.command.resume();
      await this.setStatus(false, T.connecting);
      if (!this.events?.running || this.events?.retryTimer) this.startEvents();
      if (!this.sweeper) this.startSweeper();
    }
    const result = await this.waitForLink(TIMINGS.testWait);
    await this.reading;
    if (result !== 'up') {
      const [, message] = this.lastStatus ? JSON.parse(this.lastStatus) : [];
      throw new Error(word(message ?? fill(T.offline, 0), this.language));
    }
    // Never a second full read within the gap, the button included.
    const due =
      this.lastFullRead === undefined || this.monotonic() - this.lastFullRead >= TIMINGS.readGap;
    if (!this.readOk && due) await this.fullRead();
    else if (!this.readOk) {
      // Within the gap: the MAC request alone (one frame) tells the gateway answers.
      const identity = await this.readIdentity(this.monotonic() + TIMINGS.sendBy);
      if (this.stopKind) throw new Error(word(this.stopMessage(), this.language));
      if (identity === 'ok' || identity === 'unsupported') {
        this.readOk = true;
        await this.refreshStatus();
      }
    }
    if (!this.readOk) throw new Error(word(T.readFailed, this.language));
    return this.connectedMessage();
  }
}
