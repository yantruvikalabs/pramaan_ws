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
import { query } from '../db.js';
import { config } from '../config.js';

export const CHANNEL = Object.freeze({ MOBILE: 'MOBILE', WEB: 'WEB' });

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
    displaced = await query(
      `SELECT session_id, device_label, created_at FROM sessions
        WHERE employee_id = ? AND channel = ? AND state = ?`,
      [employeeId, CHANNEL.MOBILE, SESSION_STATE.ACTIVE],
    );

    if (displaced.length > 0) {
      await query(
        `UPDATE sessions
            SET state = ?, reason = ?, ended_at = NOW(3)
          WHERE employee_id = ? AND channel = ? AND state = ?`,
        [
          SESSION_STATE.DRAIN_ONLY,
          END_REASON.SIGNED_IN_ELSEWHERE,
          employeeId,
          CHANNEL.MOBILE,
          SESSION_STATE.ACTIVE,
        ],
      );
    }
  }
  // WEB: nothing is displaced. Two computers is not fraud.

  const sessionId = randomUUID();
  await query(
    `INSERT INTO sessions (session_id, employee_id, channel, state, device_id, device_label)
     VALUES (?,?,?,?,?,?)`,
    [
      sessionId,
      employeeId,
      channel,
      SESSION_STATE.ACTIVE,
      deviceId ?? null,
      deviceLabel ?? null,
    ],
  );

  return { sessionId, displaced };
}

export async function getSession(sessionId) {
  if (!sessionId) return null;
  const rows = await query(
    `SELECT session_id, employee_id, channel, state, device_id, device_label,
            reason, created_at, last_seen_at, ended_at
       FROM sessions WHERE session_id = ?`,
    [sessionId],
  );
  return rows[0] ?? null;
}

/**
 * Has a web session been idle too long?
 *
 * Mobile never expires: a worker must not be signed out standing at a gate
 * at 6am because they did not open the app for a fortnight.
 */
export function isExpired(session, now = Date.now()) {
  if (session.channel !== CHANNEL.WEB) return false;
  const lastSeen = new Date(`${session.last_seen_at}Z`).getTime();
  return now - lastSeen > config.session.webIdleHours * 3_600_000;
}

export async function markExpired(sessionId) {
  await query(
    `UPDATE sessions SET state = ?, reason = ?, ended_at = NOW(3) WHERE session_id = ?`,
    [SESSION_STATE.REVOKED, END_REASON.EXPIRED, sessionId],
  );
}

/**
 * Bump last_seen_at, but not on every single request — a busy dashboard
 * would otherwise turn a read into a write hundreds of times an hour for no
 * benefit. Minute granularity is ample for an idle timeout measured in hours.
 */
export async function touchSession(session) {
  const lastSeen = new Date(`${session.last_seen_at}Z`).getTime();
  if (Date.now() - lastSeen < 60_000) return;
  await query('UPDATE sessions SET last_seen_at = NOW(3) WHERE session_id = ?', [
    session.session_id,
  ]);
}

/** Signing out. The user's own choice, so the session is fully closed. */
export async function endSession(sessionId, reason = END_REASON.SIGNED_OUT) {
  await query(
    `UPDATE sessions SET state = ?, reason = ?, ended_at = NOW(3)
      WHERE session_id = ? AND state <> ?`,
    [SESSION_STATE.REVOKED, reason, sessionId, SESSION_STATE.REVOKED],
  );
}

/** Every session an employee has, newest first — for the "your devices" list. */
export async function listSessions(employeeId) {
  return query(
    `SELECT session_id, channel, state, device_label, reason,
            created_at, last_seen_at, ended_at
       FROM sessions WHERE employee_id = ?
       ORDER BY last_seen_at DESC LIMIT 50`,
    [employeeId],
  );
}
