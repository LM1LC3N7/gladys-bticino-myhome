// -----------------------------------------------------------------------------
// Fixed values: manifest keys, Gladys value enums, protocol limits and timings.
// The SDK exports the Gladys categories and types, not the state values: the
// ones used here mirror server/utils/constants.js of the core.
// -----------------------------------------------------------------------------

/** Manifest keys: frozen, users store them. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** How the thermostats of the installation are wired (frozen: stored in the configuration). */
export const HEATING_PLANTS = ['central', 'standalone'];

export const LANGUAGES = ['fr', 'en'];

/** Gladys core values (server/utils/constants.js). */
export const STATE = { OFF: 0, ON: 1 };
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };
export const THERMOSTAT_MODE = { OFF: 0, HEATING: 1, COOLING: 2, AUTO: 3 };

/** The OpenWebNet gateways listen on 20000 unless changed. */
export const DEFAULT_PORT = 20000;

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const LIMITS = {
  /** One OpenWebNet frame, in bytes: longer is never a valid frame (OWNd caps at a few dozen). */
  frameBytes: 256,
  /** Frames of one answer before its ACK (a general status of a big installation). */
  answerFrames: 256,
  /** Points, shutters, zones kept: more are ignored (and said once in the logs). */
  points: 400,
  zones: 99,
  /** Set points accepted from Gladys, in degrees (OWNd: 5 to 40 °C, half degrees). */
  minSetpoint: 5,
  maxSetpoint: 40,
  /** Commands waiting for the command session: more are refused, nothing sent. */
  commandQueue: 32,
  /** Background reads waiting: more are dropped (the next read cycle asks again). */
  readQueue: 600,
  /** Protectives kept in /data for later, and how many times each is sent again. */
  pendingProtectives: 64,
  protectiveTries: 3,
  /** States per minute sent to Gladys (the core admits 300). */
  statesPerMinute: 240,
  /** Part of it only the commanded features (not the temperatures) may use. */
  priorityStates: 60,
  /** Sessions closed by the gateway between the password and its answer, in a row: a refusal. */
  authDrops: 2,
  /** The /data file, in bytes: larger is not ours. */
  stateBytes: 64 * 1024,
  /** Bytes of the socket write buffer before the session is cut. */
  pendingWrite: 16 * 1024,
};

export const TIMINGS = {
  /** TCP connection to the gateway. */
  connectTimeout: 3 * SECOND,
  /** The whole session negotiation (several frames, one bound: OWNd 30 s, kept short here). */
  negotiation: 5 * SECOND,
  /** Waits before reconnecting the event session, in a row (the last one repeats). */
  backoff: [10 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** An answer (frames then ACK / NACK) to a background read, at most. */
  readTimeout: 5 * SECOND,
  /** A request in flight without a byte for this long is cut when a protective waits. */
  stuckRead: SECOND,
  /** The command session is closed after this long without any request. */
  idleClose: 20 * SECOND,
  /** The event session is presumed dead after this long without a frame (OWNd: 65 min). */
  eventSilence: 65 * MINUTE,
  /**
   * Gladys waits 5 s for a set_value ack. A command is written by sendBy after
   * it was asked (else refused, nothing sent); the ack is given by answerBy,
   * confirmed or "sent, without confirmation".
   */
  sendBy: 2500,
  answerBy: 3300,
  /** A protective not written yet is tried again this often within its budget… */
  protectiveRetry: 250,
  /** …and this budget, from the click; then it is kept in /data and sent again later. */
  protectiveBudget: 3300,
  /** A protective kept for later is dropped after this long. */
  protectiveKeep: 10 * MINUTE,
  /** The fresh read of a zone before a thermostat command, at most. */
  readBefore: 1200,
  /** Reads of a target after a command that was not confirmed. */
  readBacks: [5 * SECOND, 20 * SECOND],
  /** The whole installation is read this often (the event session gives the changes)… */
  fullRead: 10 * MINUTE,
  /** …and never twice within this, whatever asks (restart, reconnection, button). */
  readGap: MINUTE,
  /** /data: a read or a write that takes longer fails; an unreadable file is read again this often. */
  storeTimeout: 2 * SECOND,
  storeRetry: 10 * SECOND,
  /** How often the unchanged states get their heartbeat checked. */
  sweep: MINUTE,
  /** An unchanged state is sent again this often… */
  stateHeartbeat: 30 * MINUTE,
  /** …plus a per-feature offset within this spread. */
  heartbeatSpread: 5 * MINUTE,
  /** A value older than this is not published any more. */
  stale: 2 * 60 * MINUTE,
  /** getConfig() failed in `connected`: tried again this often. */
  configRetry: 30 * SECOND,
  /** "Test the connection" waits this long at most (the manifest allows 30 s). */
  testWait: 20 * SECOND,
};
