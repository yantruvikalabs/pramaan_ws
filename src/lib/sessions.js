/**
 * Sessions — who is currently signed in, on what, and whether they still may be.
 *
 * The rules differ by channel on purpose. See the long note on the sessions
 * table in db/schema.sql for the reasoning; the short version:
 *
 *   MOBILE  one live session per person, no expiry. Anti-fraud.
 *   WEB     many browsers, each revocable, expiring on inactivity.
 */

import { randomUUID } from 'node:crypto';
import { col } from '../db/mongo.js';
import { config } from '../config.js';
import { millisSince } from './time.js';

export const CHANNEL = Object.freeze({ MOBILE: 'MOBILE', WEB: 'WEB' });

/**
 * A session document → the shape every caller already expects.
 *
 * `_id` IS session_id, but nothing outside this file should have to know that.
 * Keeping `session_id` on the returned object means middleware, routes and the
 * JWT claim all stay byte-identical to the MySQL version.
 */
const toSession = (d) => {
  if (!d) return null;
  // `_id` removed rather than aliased — see the note in lib/employee-store.js.
  const { _id, ...rest } = d;
  return { session_id: _id, ...rest };
};

export const SESSION_STATE = Object.freeze({
  ACTIVE: 'ACTIVE',
  /** May upload punches it already recorded, and nothing else. */
  DRAIN_ONLY: 'DRAIN_ONLY',
  REVOKED: 'REVOKED',
});

export const END_REASON = Object.freeze({
  SIGNED_OUT: 'SIGNED_OUT',
  SIGNED_IN_ELSEWHERE: 'SIGNED_IN_ELSEWHERE',
  DEACTIVATED: 'DEACTIVATED',
  EXPIRED: 'EXPIRED',
});

/**
 * Open a session, applying the channel's rule about what else may stay open.
 *
 * Returns { sessionId, displaced } — displaced being the sessions this login
 * pushed aside, so the caller can tell the user it happened.
 */
export async function createSession({ employeeId, channel, deviceId, deviceLabel }) {
  let displaced = [];

  if (channel === CHANNEL.MOBILE) {
    // Everything else on a phone steps aside. DRAIN_ONLY rather than
    // REVOKED so a replaced handset can still deliver attendance it already
    // captured. Those punches exist ONLY in that phone's local store until
    // they are uploaded — nothing on the server and nothing on the new
    // handset can reconstruct them — so hard-revoking would silently
    // destroy a day's work.
    const active = { employee_id: employeeId, channel: CHANNEL.MOBILE, state: SESSION_STATE.ACTIVE };
    displaced = (await col('sessions').find(active).toArray()).map(toSession);

    if (displaced.length > 0) {
      await col('sessions').updateMany(active, {
        $set: {
          state: SESSION_STATE.DRAIN_ONLY,
          reason: END_REASON.SIGNED_IN_ELSEWHERE,
          ended_at: new Date(),
        },
      });
    }
  }
  // WEB: nothing is displaced. Two computers is not fraud.

  const sessionId = randomUUID();
  const now = new Date();
  await col('sessions').insertOne({
    _id: sessionId,
    employee_id: employeeId,
    channel,
    state: SESSION_STATE.ACTIVE,
    device_id: deviceId ?? null,
    device_label: deviceLabel ?? null,
    reason: null,
    created_at: now,
    last_seen_at: now,
    ended_at: null,
  });

  return { sessionId, displaced };
}

export async function getSession(sessionId) {
  if (!sessionId) return null;
  return toSession(await col('sessions').findOne({ _id: sessionId }));
}

/**
 * Has a web session been idle too long?
 *
 * Mobile never expires: a worker must not be signed out standing at a gate
 * at 6am because they did not open the app for a fortnight.
 */
export function isExpired(session, now = Date.now()) {
  if (session.channel !== CHANNEL.WEB) return false;
  return millisSince(session.last_seen_at, 'session.last_seen_at', now)
    > config.session.webIdleHours * 3_600_000;
}

export async function markExpired(sessionId) {
  await col('sessions').updateOne(
    { _id: sessionId },
    { $set: { state: SESSION_STATE.REVOKED, reason: END_REASON.EXPIRED, ended_at: new Date() } },
  );
}

/**
 * Bump last_seen_at, but not on every single request — a busy dashboard
 * would otherwise turn a read into a write hundreds of times an hour for no
 * benefit. Minute granularity is ample for an idle timeout measured in hours.
 */
export async function touchSession(session) {
  if (millisSince(session.last_seen_at, 'session.last_seen_at') < 60_000) return;
  await col('sessions').updateOne(
    { _id: session.session_id },
    { $set: { last_seen_at: new Date() } },
  );
}

/** Signing out. The user's own choice, so the session is fully closed. */
export async function endSession(sessionId, reason = END_REASON.SIGNED_OUT) {
  await col('sessions').updateOne(
    { _id: sessionId, state: { $ne: SESSION_STATE.REVOKED } },
    { $set: { state: SESSION_STATE.REVOKED, reason, ended_at: new Date() } },
  );
}

/** Every session an employee has, newest first — for the "your devices" list. */
export async function listSessions(employeeId) {
  const rows = await col('sessions')
    .find({ employee_id: employeeId })
    .sort({ last_seen_at: -1 })
    .limit(50)
    .toArray();
  return rows.map(toSession);
}
