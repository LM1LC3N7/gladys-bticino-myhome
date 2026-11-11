// -----------------------------------------------------------------------------
// One OpenWebNet session over TCP: the command session (`*99*0##`, then
// `*99*9##` when the gateway refuses it) or the event session (`*99*1##`).
// The negotiation is OWNd's (OWNd/connection/session.py _negotiate_exchange,
// Apache-2.0 since 2026-09-29, see THIRD_PARTY_NOTICES.md): the session
// request, the gateway's greeting, then no password (ACK), the legacy
// numeric password (a nonce) or the HMAC one (`*98*1##` SHA-1, `*98*2##`
// SHA-256) with the mutual check of the gateway's answer.
//
// Changed from OWNd:
// - the whole negotiation is bounded (TIMINGS.negotiation, 5 frames), the
//   TCP connection too; the password and the answers derived from it are
//   never logged, never kept;
// - a gateway that closes the session right after the password is told
//   apart (`closedAfterPassword`), so two in a row count as a refusal;
// - a command session carries one request at a time (no pipeline): its
//   answer is the frames up to the ACK or NACK (at most LIMITS.answerFrames),
//   and `lastByteAt` tells how long the gateway has been silent.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';
import {
  algorithmOf,
  clientRandom,
  hmacAnswer,
  hmacExpected,
  openPassword,
  sameDigits,
} from './auth.js';
import { FRAMES, FrameReader, parse } from './frames.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * kind:
 * - `offline`: no TCP connection (refused, timeout, unreachable): nothing sent;
 * - `busy`: the gateway refused the session itself (NACK to the request);
 * - `refused`: the gateway refused the password (NACK after it);
 * - `passwordRequired`: the gateway asks for a password and none is set;
 * - `passwordInvalid`: a legacy gateway (nonce) and a password that is not digits only;
 * - `identity`: the gateway could not prove it knows the password (HMAC check);
 * - `protocol`: an unexpected frame during the negotiation;
 * - `timeout`: no answer in time; `lost`: the session ended. `sent` tells
 *   whether the request was written.
 */
export class OwnError extends Error {
  constructor(message, kind, { sent = false, closedAfterPassword = false } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
    this.closedAfterPassword = closedAfterPassword;
  }
}

function defaultConnect({ host, port }) {
  return createConnection({ host, port });
}

export class OwnSession extends EventEmitter {
  constructor({
    host,
    port,
    password = '',
    kind = 'command',
    connect = defaultConnect,
    timers = globalThis,
    monotonic = () => performance.now(),
    logger = silent,
    random,
  }) {
    super();
    this.host = host;
    this.port = port;
    this.password = password;
    this.kind = kind;
    this.connectFn = connect;
    this.timers = timers;
    this.monotonic = monotonic;
    this.logger = logger;
    this.random = random;
    this.socket = undefined;
    this.open = false;
    this.ended = false;
    this.queue = [];
    this.waiting = undefined;
    this.inflight = undefined;
    this.lastByteAt = monotonic();
    this.dropped = 0;
    this.closedPromise = new Promise((resolve) => {
      this.markClosed = resolve;
    });
  }

  /** Connects and negotiates; resolves once the session is open. */
  start() {
    return new Promise((resolve, reject) => {
      let socket;
      const fail = (err) => {
        this.timers.clearTimeout(deadline);
        this.destroy();
        reject(err);
      };
      const deadline = this.timers.setTimeout(
        () =>
          fail(
            new OwnError(
              socket && this.connected
                ? 'No answer during the negotiation'
                : 'Connection timed out',
              socket && this.connected ? 'timeout' : 'offline',
              // Silence is never a refusal (only a session closed after the password counts).
              { closedAfterPassword: false },
            ),
          ),
        TIMINGS.connectTimeout + TIMINGS.negotiation,
      );
      try {
        socket = this.connectFn({ host: this.host, port: this.port });
      } catch (err) {
        fail(new OwnError(`Connection failed: ${err.message}`, 'offline'));
        return;
      }
      this.socket = socket;
      socket.setNoDelay?.(true);
      socket.setKeepAlive?.(true, 30_000);
      const connectTimer = this.timers.setTimeout(() => {
        if (!this.connected) fail(new OwnError('Connection timed out', 'offline'));
      }, TIMINGS.connectTimeout);
      this.reader = new FrameReader({
        onFrame: (frame) => this.onFrame(frame),
        onDrop: () => {
          this.dropped += 1;
        },
      });
      socket.on('connect', () => {
        this.timers.clearTimeout(connectTimer);
        this.connected = true;
        this.negotiate().then(
          () => {
            this.timers.clearTimeout(deadline);
            this.open = true;
            this.logger.debug(`OpenWebNet ${this.kind} session open`);
            resolve();
            // Frames that came with the end of the negotiation.
            for (const frame of this.queue.splice(0)) this.onFrame(frame);
          },
          (err) => fail(err),
        );
      });
      socket.on('data', (chunk) => {
        this.lastByteAt = this.monotonic();
        this.reader.push(chunk);
      });
      // Before the session is open, an error or a close fails the start.
      const early = (reason) => {
        if (this.open) return;
        fail(
          this.verdict ??
            new OwnError(`Connection failed (${reason})`, this.passwordSent ? 'lost' : 'offline', {
              closedAfterPassword: Boolean(this.passwordSent && !this.cutHere),
            }),
        );
      };
      socket.on('error', (err) => {
        early(err.code ?? 'error');
        if (!this.ended) this.end(err.code ?? err.message);
      });
      socket.on('close', () => {
        this.timers.clearTimeout(connectTimer);
        early('closed by the gateway');
        this.end('connection closed by the gateway');
        this.markClosed();
      });
    });
  }

  // --- Negotiation ------------------------------------------------------------

  /** The next frame of the negotiation (no request in flight yet). */
  nextFrame() {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  /** The negotiation's verdict, set before the last frame is written (the gateway may close at once). */
  fatal(err, frame) {
    this.verdict = err;
    if (frame) this.write(frame);
    throw err;
  }

  write(text) {
    if (!this.socket || this.ended) throw new OwnError('Not connected', 'lost');
    this.socket.write(text);
  }

  async negotiate() {
    let frames = 0;
    const read = async () => {
      frames += 1;
      if (frames > 5) throw new OwnError('Too many frames during the negotiation', 'protocol');
      return parse(await this.nextFrame());
    };
    if (this.password && !/^[\x21-\x7e]+$/.test(this.password)) {
      throw new OwnError('The password must be printable ASCII characters', 'passwordInvalid');
    }
    this.write(this.kind === 'event' ? FRAMES.eventSession : FRAMES.commandSession);
    let message = await read();
    if (message.kind === 'nack' && this.kind === 'command') {
      this.write(FRAMES.commandSessionAlternate);
      message = await read();
    }
    if (message.kind !== 'ack') {
      throw new OwnError(
        'The gateway refused the session',
        message.kind === 'nack' ? 'busy' : 'protocol',
      );
    }
    message = await read();
    if (message.kind === 'ack') return;
    if (message.kind === 'nack') throw new OwnError('The gateway refused the session', 'busy');
    if (message.kind === 'sha') {
      const algorithm = algorithmOf(message.version);
      if (!algorithm) throw new OwnError('Unknown password method', 'protocol');
      if (!this.password) {
        this.fatal(
          new OwnError('The gateway asks for its OPEN password', 'passwordRequired'),
          FRAMES.nack,
        );
      }
      this.write(FRAMES.ack);
      const nonce = await read();
      if (nonce.kind !== 'nonce') throw new OwnError('Unexpected frame', 'protocol');
      const ra = nonce.nonce;
      const rb = clientRandom(algorithm, this.random);
      this.write(`*#${rb}*${hmacAnswer(algorithm, this.password, ra, rb)}##`);
      this.passwordSent = true;
      this.logger.debug('OpenWebNet password sent (hidden)');
      const answer = await read();
      if (answer.kind === 'nack') throw new OwnError('The gateway refused the password', 'refused');
      if (answer.kind !== 'nonce') throw new OwnError('Unexpected frame', 'protocol');
      if (!sameDigits(answer.nonce, hmacExpected(algorithm, this.password, ra, rb))) {
        this.fatal(
          new OwnError('The gateway did not prove it knows the password', 'identity'),
          FRAMES.nack,
        );
      }
      this.write(FRAMES.ack);
      return;
    }
    if (message.kind === 'nonce') {
      if (!this.password)
        throw new OwnError('The gateway asks for its OPEN password', 'passwordRequired');
      if (!/^[0-9]{1,10}$/.test(this.password)) {
        throw new OwnError('This gateway takes a password of digits only', 'passwordInvalid');
      }
      this.write(`*#${openPassword(this.password, message.nonce)}##`);
      this.passwordSent = true;
      this.logger.debug('OpenWebNet password sent (hidden)');
      const answer = await read();
      if (answer.kind === 'ack') return;
      if (answer.kind === 'nack') throw new OwnError('The gateway refused the password', 'refused');
      throw new OwnError('Unexpected frame', 'protocol');
    }
    throw new OwnError('Unexpected frame', 'protocol');
  }

  // --- Frames -----------------------------------------------------------------

  onFrame(frame) {
    if (!this.open) {
      if (this.waiting) {
        const { resolve } = this.waiting;
        this.waiting = undefined;
        resolve(frame);
      } else if (this.queue.length < 8) {
        this.queue.push(frame);
      }
      return;
    }
    if (this.kind === 'event') {
      this.emit('frame', frame);
      return;
    }
    const request = this.inflight;
    if (!request) return; // nothing asked: not ours
    const message = parse(frame);
    if (message.kind === 'ack' || message.kind === 'nack') {
      this.inflight = undefined;
      this.timers.clearTimeout(request.timer);
      request.resolve({ ack: message.kind === 'ack', frames: request.frames });
      return;
    }
    if (request.frames.length >= LIMITS.answerFrames) {
      this.inflight = undefined;
      this.timers.clearTimeout(request.timer);
      request.reject(new OwnError('Answer too long', 'protocol', { sent: true }));
      this.destroy();
      return;
    }
    request.frames.push(message);
  }

  /**
   * Writes one request and resolves with { ack, frames } once the gateway
   * ends its answer with ACK or NACK. `onWritten` is called once the frame is
   * on the socket.
   */
  request(frame, { timeout = TIMINGS.readTimeout, onWritten } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.open || this.ended) {
        reject(new OwnError('Not connected', 'offline'));
        return;
      }
      if (this.inflight) {
        reject(new OwnError('A request is already in flight', 'offline'));
        return;
      }
      const request = { frames: [], resolve, reject };
      request.timer = this.timers.setTimeout(() => {
        if (this.inflight !== request) return;
        this.inflight = undefined;
        reject(new OwnError('No answer from the gateway in time', 'timeout', { sent: true }));
        // An answer may still come: the session is not reused.
        this.destroy();
      }, timeout);
      this.inflight = request;
      this.inflightSince = this.monotonic();
      this.lastByteAt = this.monotonic();
      try {
        this.socket.write(frame);
      } catch (err) {
        this.inflight = undefined;
        this.timers.clearTimeout(request.timer);
        reject(new OwnError(err.message, 'lost', { sent: true }));
        this.destroy();
        return;
      }
      onWritten?.();
      if ((this.socket?.writableLength ?? 0) > LIMITS.pendingWrite) {
        this.destroy();
      }
    });
  }

  /** The session ended: every waiter fails. */
  end(reason) {
    if (this.ended) return;
    this.ended = true;
    this.open = false;
    if (this.waiting) {
      // During the negotiation: closed right after the password is told apart.
      const { reject } = this.waiting;
      this.waiting = undefined;
      reject(
        new OwnError(`The session ended (${reason})`, this.passwordSent ? 'lost' : 'offline', {
          // Cut by this side (a protective waiting, a stop): not the gateway's answer.
          closedAfterPassword: Boolean(this.passwordSent && !this.cutHere),
        }),
      );
    }
    const request = this.inflight;
    if (request) {
      this.inflight = undefined;
      this.timers.clearTimeout(request.timer);
      request.reject(new OwnError(`The session ended (${reason})`, 'lost', { sent: true }));
    }
    this.emit('end', reason);
  }

  /** Cuts the socket now; `closed` resolves once it is closed (bounded by the caller). */
  destroy() {
    const socket = this.socket;
    if (!this.ended) this.cutHere = true;
    this.end('cut');
    if (!socket) {
      this.markClosed();
      return;
    }
    socket.destroy();
  }

  get closed() {
    return this.closedPromise;
  }
}
