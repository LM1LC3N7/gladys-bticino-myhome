// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), readable by the container user only (0600), tied to the
// gateway address it was learnt from:
//   - `refused`: the gateway refused the password: an 8-bit salted mark of
//     that password (never the password, never a usable digest of it), so a
//     restart never sends it again by itself; lifted by a success;
//   - `mac`: the MAC address the gateway gave, to tell another gateway at
//     the same address;
//   - `pending`: the protective commands (light off, shutter stop, heating
//     off) not written yet, sent again when the gateway answers (3 times at
//     most, 10 minutes at most);
//   - `lastReadAt`: when the installation was last read, so a restart never
//     reads it again sooner than TIMINGS.readGap;
//   - `dimmers`, `coarse`, `advanced`: what the frames taught about the
//     points (a dimmer, a dimmer that only takes the coarse levels, a shutter
//     that gives its position), so the devices keep their features.
// Times are wall-clock milliseconds (for the restart only); a time in the
// future is not trusted.
//
// Nothing ever waits for /data without a bound: a read or a write that takes
// longer than TIMINGS.storeTimeout fails, a special file (FIFO, device, link)
// is refused, and an unreadable file is never overwritten (the app reads it
// again later). The store of LM1LC3N7/gladys-becker (same author, Apache-2.0).
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';
import { pointOf } from './own/frames.js';

export const STATE_FILE = '/data/bticino-myhome-state.json';

const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW, O_NONBLOCK } = constants;

/** `promise`, or a rejection after `ms` (the work itself may go on, never awaited). */
function bounded(promise, ms, timers) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = timers.setTimeout(() => reject(new Error('/data too slow')), ms);
    }),
  ]).finally(() => timers.clearTimeout(timer));
}

async function readSmallFile(path) {
  // O_NONBLOCK: opening a FIFO never blocks; O_NOFOLLOW: never a link.
  const handle = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > LIMITS.stateBytes) throw new Error('too large');
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close().catch(() => {});
  }
}

async function writeSmallFile(path, text) {
  const temporary = `${path}.tmp`;
  const handle = await open(
    temporary,
    O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_NONBLOCK,
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    await handle.writeFile(text, 'utf8');
  } finally {
    await handle.close().catch(() => {});
  }
  await rename(temporary, path);
}

/**
 * The /data file. `load()` resolves `{ data }`, `{ missing: true }` or
 * `{ broken: true }`; `save(data)` writes the latest data given (a save asked
 * while another runs replaces any one still waiting) and rejects after the
 * bound.
 */
export function fileStore({
  path = STATE_FILE,
  timeout = TIMINGS.storeTimeout,
  timers = globalThis,
  read = readSmallFile,
  write = writeSmallFile,
} = {}) {
  let running = null;
  let waiting = null;
  const run = () => {
    const job = waiting;
    waiting = null;
    running = write(path, job.text).then(
      () => job.resolve(),
      (err) => job.reject(err),
    );
    running.finally(() => {
      running = null;
      if (waiting) run();
    });
  };
  return {
    async load() {
      try {
        const text = await bounded(read(path), timeout, timers);
        return { data: JSON.parse(text) };
      } catch (err) {
        return err?.code === 'ENOENT' ? { missing: true } : { broken: true };
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const promise = new Promise((resolve, reject) => {
        waiting?.resolve();
        waiting = { text, resolve, reject };
      });
      if (!running) run();
      return bounded(promise, timeout, timers);
    },
  };
}

/** For the tests: the same JSON round trip as the file; `hang`, `fail`, `broken`, `loading`. */
export function memoryStore(initial = null, { broken = false, loading } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    loads: 0,
    hang: false,
    fail: false,
    broken,
    loading,
    async load() {
      this.loads += 1;
      if (this.loading) await this.loading;
      if (this.broken) return { broken: true };
      return this.data === null
        ? { missing: true }
        : { data: JSON.parse(JSON.stringify(this.data)) };
    },
    save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.fail) return Promise.reject(new Error('disk full'));
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
      return Promise.resolve();
    },
  };
}

const PENDING_KINDS = ['lightOff', 'shutterStop', 'zoneOff'];

const pointList = (raw) =>
  Array.isArray(raw)
    ? [...new Set(raw.map((p) => pointOf(p)).filter(Boolean))].slice(0, LIMITS.points)
    : [];

/** A wall time from /data: a number, never in the future (else 0). */
const pastTime = (value, now) => (Number.isFinite(value) && value > 0 && value <= now ? value : 0);

/** The persisted memory, repaired. `now`: the wall clock. */
export function normalizeMemory(raw, now) {
  const place = typeof raw?.place === 'string' && raw.place.length <= 300 ? raw.place : '';
  const refused =
    raw?.refused &&
    Number.isInteger(raw.refused.mark) &&
    raw.refused.mark >= 0 &&
    raw.refused.mark <= 255 &&
    typeof raw.refused.salt === 'string' &&
    /^[0-9a-f]{16,64}$/.test(raw.refused.salt)
      ? { mark: raw.refused.mark, salt: raw.refused.salt, kind: String(raw.refused.kind ?? '') }
      : null;
  const mac =
    typeof raw?.mac === 'string' && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(raw.mac) ? raw.mac : null;
  const pending = Array.isArray(raw?.pending)
    ? raw.pending
        .filter(
          (p) =>
            p &&
            PENDING_KINDS.includes(p.kind) &&
            typeof p.target === 'string' &&
            p.target.length <= 40 &&
            typeof p.frame === 'string' &&
            /^\*[0-9*#]{4,40}##$/.test(p.frame) &&
            pastTime(p.at, now) > 0 &&
            Number.isInteger(p.tries) &&
            p.tries >= 0,
        )
        .slice(0, LIMITS.pendingProtectives)
        .map((p) => ({ kind: p.kind, target: p.target, frame: p.frame, at: p.at, tries: p.tries }))
    : [];
  return {
    version: 1,
    place,
    refused,
    mac,
    pending,
    lastReadAt: pastTime(raw?.lastReadAt, now),
    dimmers: pointList(raw?.dimmers),
    coarse: pointList(raw?.coarse),
    advanced: pointList(raw?.advanced),
  };
}
