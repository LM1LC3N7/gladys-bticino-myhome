// -----------------------------------------------------------------------------
// The two links to the gateway.
//
// CommandLink: ONE command session at a time, opened when a request waits
// and closed after TIMINGS.idleClose without one. One request in flight (no
// pipeline). Three queues, in this order: protectives (light off, shutter
// stop, heating off), commands, background reads. A protective never waits
// behind a read the gateway leaves silent: a request in flight without a
// byte for TIMINGS.stuckRead is cut (the session closed, and the next one
// opened only once the old socket is closed), and a protective cancels the
// commands of the same target still waiting (nothing asked before a stop
// leaves after it). A job is never written after its `sendBy`, and its
// `check()` is asked right before the write (an option switched off
// withdraws it).
//
// EventLink: the event session (the gateway's monitor), reconnected after
// 10 s, 30 s, 1 min, 2 min, then every 5 min; never again by itself after a
// refused password (or two sessions closed right after it).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { LIMITS, TIMINGS } from './constants.js';
import { OwnError } from './own/session.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Errors of the negotiation that stop the links until the user acts. */
export const STOPPING = new Set(['refused', 'passwordRequired', 'passwordInvalid', 'identity']);

const ORDER = ['protective', 'command', 'read'];

export class CommandLink extends EventEmitter {
  constructor({ timers = globalThis, monotonic, logger = silent, session }) {
    super();
    this.timers = timers;
    this.monotonic = monotonic;
    this.logger = logger;
    /** () -> an unopened OwnSession, or undefined when not configured. */
    this.makeSession = session;
    this.queues = { protective: [], command: [], read: [] };
    this.session = undefined;
    this.current = undefined;
    this.running = false;
    this.stopped = false;
    this.idleTimer = undefined;
    this.watchTimer = undefined;
    this.authDrops = 0;
    this.generation = 0;
  }

  get waiting() {
    return ORDER.reduce((n, kind) => n + this.queues[kind].length, 0);
  }

  get busy() {
    return Boolean(this.current);
  }

  /**
   * Queues a request: { frame, kind, target, sendBy, check, onWritten,
   * timeout }. Resolves with { ack, frames }; rejects with an OwnError
   * (`sent` false: nothing written).
   */
  submit(job) {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        reject(new OwnError('Stopped', 'offline'));
        return;
      }
      const kind = ORDER.includes(job.kind) ? job.kind : 'command';
      const queue = this.queues[kind];
      const cap = kind === 'read' ? LIMITS.readQueue : LIMITS.commandQueue;
      if (queue.length >= cap) {
        reject(new OwnError('Too many requests waiting', 'full'));
        return;
      }
      const entry = {
        ...job,
        kind,
        resolve,
        reject,
        generation: this.generation,
        queuedAt: this.monotonic(),
      };
      if (kind === 'protective' && !job.resend) {
        // Nothing of this target asked before the protective leaves after it
        // (a protective sent again later never cancels a newer command).
        this.cancel(job.target, 'replaced');
      }
      queue.push(entry);
      if (kind !== 'read') this.watch();
      this.pump();
    });
  }

  /** Withdraws the commands (not the protectives, not the reads) of a target still waiting. */
  cancel(target, why = 'replaced') {
    if (target === undefined) return;
    const queue = this.queues.command;
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].target === target) {
        const [entry] = queue.splice(i, 1);
        entry.reject(new OwnError('Replaced by a newer protective command', why));
      }
    }
  }

  next() {
    const now = this.monotonic();
    // The protectives kept for later go before any other request (the app queues them here).
    if (this.queues.protective.length === 0) this.beforeOrdinary?.();
    for (const kind of ORDER) {
      const queue = this.queues[kind];
      while (queue.length > 0) {
        const entry = queue.shift();
        if (entry.sendBy !== undefined && now > entry.sendBy) {
          entry.reject(new OwnError('Not written in time', 'late'));
          continue;
        }
        return entry;
      }
    }
    return undefined;
  }

  pump() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.loop()
      .catch((err) => this.logger.error(`OpenWebNet command link: ${err.message}`))
      .finally(() => {
        this.running = false;
        if (this.waiting > 0 && !this.stopped) this.pump();
      });
  }

  async loop() {
    for (;;) {
      const entry = this.next();
      if (!entry) break;
      this.clearIdle();
      let session;
      try {
        this.opening = entry;
        session = await this.ensureSession(entry);
      } catch (err) {
        entry.reject(err);
        // The gateway does not answer (or refused): what waits fails now,
        // nothing sent; the protectives are tried again by the app within
        // their budget. Never a second session right after a failed one.
        this.failAll(err);
        continue;
      } finally {
        this.opening = undefined;
      }
      if (entry.sendBy !== undefined && this.monotonic() > entry.sendBy) {
        entry.reject(new OwnError('Not written in time', 'late'));
        continue;
      }
      if (entry.check && !entry.check()) {
        entry.reject(new OwnError('Withdrawn: not allowed any more', 'withdrawn'));
        continue;
      }
      this.current = entry;
      try {
        const answer = await session.request(entry.frame, {
          timeout: entry.timeout ?? TIMINGS.readTimeout,
          onWritten: () => {
            entry.written = true;
            entry.onWritten?.();
          },
        });
        entry.resolve(answer);
      } catch (err) {
        entry.reject(err);
      } finally {
        this.current = undefined;
      }
    }
    this.armIdle();
  }

  /** The open session, or a new one once the old socket is closed. */
  async ensureSession(entry) {
    if (this.session?.open && !this.session.ended) return this.session;
    if (this.session) {
      const old = this.session;
      this.session = undefined;
      old.destroy();
      await this.bounded(old.closed, 500);
    }
    const session = this.makeSession?.();
    if (!session) throw new OwnError('Not configured', 'offline');
    this.session = session;
    const generation = this.generation;
    try {
      await session.start();
    } catch (err) {
      if (this.session === session) this.session = undefined;
      if (generation === this.generation) this.noteFailure(err);
      throw err;
    }
    if (generation !== this.generation) {
      session.destroy();
      throw new OwnError('Stopped', 'offline');
    }
    this.authDrops = 0;
    this.emit('open', { protective: entry.kind === 'protective' });
    return session;
  }

  noteFailure(err) {
    if (err.closedAfterPassword) {
      this.authDrops += 1;
      if (this.authDrops >= LIMITS.authDrops) {
        this.emit('refused', new OwnError('Closed right after the password, twice', 'refused'));
      }
      return;
    }
    if (STOPPING.has(err.kind)) this.emit('refused', err);
  }

  bounded(promise, ms) {
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(resolve, ms);
      promise.then(() => {
        this.timers.clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * While a protective waits, a request in flight (or a session being opened
   * for something else) without a byte for 1 s is cut; while a command
   * waits, a silent background read is.
   */
  watch() {
    if (this.watchTimer) return;
    this.watchTimer = this.timers.setInterval(() => {
      const top = ORDER.find((kind) => this.queues[kind].length > 0);
      if (top === undefined || top === 'read') {
        this.timers.clearInterval(this.watchTimer);
        this.watchTimer = undefined;
        return;
      }
      const busy = this.current ?? (this.session && !this.session.open ? this.opening : undefined);
      const session = this.session;
      if (!busy || !session || ORDER.indexOf(busy.kind) <= ORDER.indexOf(top)) return;
      const now = this.monotonic();
      // A protective never waits past its budget behind a request that trickles.
      const waited = top === 'protective' ? now - this.queues.protective[0].queuedAt : 0;
      if (now - session.lastByteAt >= TIMINGS.stuckRead || waited >= TIMINGS.protectiveCut) {
        this.logger.warn('OpenWebNet: a silent request is cut for a protective command');
        session.destroy();
      }
    }, 100);
  }

  failAll(err) {
    for (const kind of ORDER) {
      for (const entry of this.queues[kind].splice(0)) {
        entry.reject(new OwnError(err.message, err.kind === 'full' ? 'offline' : err.kind));
      }
    }
  }

  armIdle() {
    this.clearIdle();
    if (!this.session || this.stopped) return;
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = undefined;
      if (this.current || this.waiting > 0) return;
      const session = this.session;
      this.session = undefined;
      session?.destroy();
    }, TIMINGS.idleClose);
  }

  clearIdle() {
    if (this.idleTimer) {
      this.timers.clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Closes the session; every request waiting fails (nothing sent). */
  stop() {
    this.stopped = true;
    this.generation += 1;
    this.clearIdle();
    if (this.watchTimer) {
      this.timers.clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
    this.failAll(new OwnError('Stopped', 'offline'));
    const session = this.session;
    this.session = undefined;
    session?.destroy();
  }

  /** Back in service (after a stop), with the same session factory. */
  resume() {
    this.stopped = false;
    this.authDrops = 0;
  }
}

export class EventLink extends EventEmitter {
  constructor({ timers = globalThis, monotonic, logger = silent, session }) {
    super();
    this.timers = timers;
    this.monotonic = monotonic;
    this.logger = logger;
    this.makeSession = session;
    this.session = undefined;
    this.running = false;
    this.up = false;
    this.failures = 0;
    this.authDrops = 0;
    this.generation = 0;
    this.retryTimer = undefined;
    this.silenceTimer = undefined;
  }

  start() {
    this.stop();
    this.running = true;
    this.failures = 0;
    this.authDrops = 0;
    this.open();
  }

  stop() {
    this.running = false;
    this.generation += 1;
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.clearSilence();
    const session = this.session;
    this.session = undefined;
    const wasUp = this.up;
    this.up = false;
    session?.destroy();
    if (wasUp) this.emit('down', { reason: 'stopped', stopped: true });
  }

  open() {
    const generation = this.generation;
    const session = this.makeSession?.();
    if (!session) return;
    this.session = session;
    session.on('frame', (frame) => {
      if (generation !== this.generation) return;
      this.armSilence(generation);
      this.emit('frame', frame);
    });
    session.on('end', (reason) => {
      if (generation !== this.generation || !this.up) return;
      this.lost(generation, reason);
    });
    session.start().then(
      () => {
        if (generation !== this.generation) {
          session.destroy();
          return;
        }
        this.up = true;
        this.authDrops = 0;
        this.armSilence(generation);
        this.emit('up');
      },
      (err) => {
        if (generation !== this.generation) return;
        this.failed(generation, err);
      },
    );
  }

  failed(generation, err) {
    this.session = undefined;
    if (err.closedAfterPassword) {
      this.authDrops += 1;
      if (this.authDrops >= LIMITS.authDrops) {
        this.refuse(new OwnError('Closed right after the password, twice', 'refused'));
        return;
      }
    } else if (STOPPING.has(err.kind)) {
      this.refuse(err);
      return;
    }
    this.retry(generation, err.message);
  }

  refuse(err) {
    this.running = false;
    this.generation += 1;
    this.emit('refused', err);
  }

  lost(generation, reason) {
    this.up = false;
    this.session = undefined;
    this.clearSilence();
    // The session worked: the waits start again from the first one.
    this.failures = 0;
    this.retry(generation, reason, true);
  }

  retry(generation, reason, wasUp = false) {
    if (!this.running || generation !== this.generation) return;
    this.generation += 1;
    const next = this.generation;
    this.failures += 1;
    const wait = TIMINGS.backoff[Math.min(this.failures - 1, TIMINGS.backoff.length - 1)];
    this.emit('down', { reason, retryIn: wait, wasUp });
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.running && next === this.generation) this.open();
    }, wait);
  }

  armSilence(generation) {
    this.clearSilence();
    this.silenceTimer = this.timers.setTimeout(() => {
      this.silenceTimer = undefined;
      if (generation !== this.generation || !this.up) return;
      this.logger.warn('OpenWebNet: nothing on the event session for too long, reconnecting');
      const session = this.session;
      this.lost(generation, 'silent for too long');
      session?.destroy();
    }, TIMINGS.eventSilence);
  }

  clearSilence() {
    if (this.silenceTimer) this.timers.clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }
}
