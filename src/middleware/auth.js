/**
 * Authentication and role gates, as Express middleware.
 *
 * Role is resolved from the employee master at login and put in the token —
 * never chosen by the user. FRD BR-ROL-1.
 */

import jwt from 'jsonwebtoken';
import { roleAtLeast } from '@pramaan/shared';
import { config } from '../config.js';
import { query } from '../db.js';
import {
  SESSION_STATE,
  END_REASON,
  getSession,
  isExpired,
  markExpired,
  touchSession,
} from '../lib/sessions.js';

const EMPLOYEE_COLUMNS =
  'employee_id, name, phone, email, role, reports_to, status, language';

export function signToken(payload) {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

function bearerFrom(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/**
 * Verify the token, check the session is still live, and re-read the
 * employee — so both a deactivated account and a revoked device stop working
 * on the very next request rather than whenever the token happens to expire.
 *
 * Three database reads sounds like a lot for every request. It is two: the
 * employee read was already here, and the session read is a primary-key
 * lookup. That is the whole price of being able to sign somebody out
 * instantly, and it is why this design needs no refresh tokens.
 *
 * @param {object} [options]
 * @param {boolean} [options.allowDrainOnly]
 *   Let a displaced phone through. Exactly ONE caller sets this: the event
 *   ingest endpoint. A phone replaced by a newer sign-in may still hold
 *   punches captured offline, which exist nowhere else — refusing them would
 *   silently destroy a day's attendance (D-33). Nothing else may set it.
 */
export function authenticate({ allowDrainOnly = false } = {}) {
  return async function authenticated(req, res, next) {
    const unauthenticated = () =>
      res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Sign in again.' });

    const token = bearerFrom(req);
    if (!token) return unauthenticated();

    let claims;
    try {
      claims = jwt.verify(token, config.jwt.secret);
    } catch {
      return unauthenticated();
    }

    const session = await getSession(claims.sid);
    if (!session || session.employee_id !== claims.sub) return unauthenticated();

    if (isExpired(session)) {
      await markExpired(session.session_id);
      return res.status(401).json({
        error: 'SESSION_EXPIRED',
        message: 'You were signed out after a period of inactivity. Sign in again.',
      });
    }

    // Event ingest is the ONE caller allowed past this, so a phone replaced
    // by a newer sign-in can still deliver punches it captured offline —
    // they exist nowhere else, and refusing them would silently destroy a
    // day's attendance (D-33).
    if (session.state === SESSION_STATE.DRAIN_ONLY && !allowDrainOnly) {
      // Name the event. "Sign in again" would leave a worker wondering
      // whether the app is broken, and it is the one message that tells a
      // supervisor somebody else has their account on a phone.
      return res.status(401).json({
        error: 'SIGNED_IN_ELSEWHERE',
        message: 'You signed in on a different phone. Sign in again to use this one.',
        at: session.ended_at,
      });
    }

    if (session.state === SESSION_STATE.REVOKED) {
      const message =
        session.reason === END_REASON.DEACTIVATED
          ? 'This account is no longer active. Contact your senior.'
          : 'You were signed out. Sign in again.';
      return res.status(401).json({ error: 'SESSION_ENDED', message });
    }

    const rows = await query(
      `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE employee_id = ?`,
      [claims.sub],
    );
    const employee = rows[0];

    if (!employee) return unauthenticated();
    if (employee.status === 'INACTIVE') {
      return res.status(403).json({
        error: 'INACTIVE',
        message: 'This account is no longer active. Contact your senior.',
      });
    }

    req.employee = employee;
    req.session = session;
    req.claims = claims;

    // Fire and forget: the idle clock must never be able to fail a request.
    touchSession(session).catch(() => {});

    return next();
  };
}

/** The gate every normal endpoint uses. */
export const requireAuth = authenticate();

/**
 * Event ingest only. See authenticate(). Using this anywhere else would let
 * a phone the worker has replaced keep operating as if it were current.
 */
export const requireAuthAllowingDrain = authenticate({ allowDrainOnly: true });

/** Minimum role. Returns 403 with a plain message, never a stack trace. */
export function requireRole(minimum) {
  return function roleGate(req, res, next) {
    if (!req.employee) {
      return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Sign in again.' });
    }
    if (!roleAtLeast(req.employee.role, minimum)) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'You do not have access to this.',
      });
    }
    return next();
  };
}

