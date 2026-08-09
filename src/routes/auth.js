/**
 * Login.
 *
 * One box. The user types their phone number, their email address, or their
 * employee ID, and the server works out which it is. A one-time code follows
 * — by SMS to a phone, by email to an address. No passwords anywhere in the
 * product: nothing to steal, nothing to reset, nothing to explain.
 *
 * Sessions, not token expiry, decide who is signed in. See lib/sessions.js
 * and the note on the sessions table in db/schema.sql.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { WEB_ROLES } from '@pramaan/shared';
import { capabilitiesFor } from '../lib/capabilities.js';
import { classifyIdentifier, lookupFor, maskDestination } from '../lib/identity.js';
import { sendCode } from '../lib/notify.js';
import {
  CHANNEL,
  SESSION_STATE,
  createSession,
  endSession,
  getSession,
  listSessions,
} from '../lib/sessions.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { otpRequestLimiter, otpVerifyLimiter } from '../middleware/rate-limit.js';
import { query } from '../db.js';
import { config } from '../config.js';

const identifier = z.string().trim().min(1).max(255);

const requestSchema = z.object({
  identifier,
});

const verifySchema = z.object({
  identifier,
  code: z.string().trim().regex(/^\d{4,8}$/),
  channel: z.enum([CHANNEL.MOBILE, CHANNEL.WEB]).default(CHANNEL.MOBILE),
  device_id: z.string().trim().max(64).optional(),
  device_label: z.string().trim().max(120).optional(),
});

const hash = (code, employeeId) =>
  createHash('sha256').update(`${employeeId}:${code}`).digest('hex');

/** Find the employee behind whatever the user typed. */
async function resolveEmployee(raw) {
  const id = classifyIdentifier(raw);
  if (!id) return null;

  const { column, value, channel } = lookupFor(id);
  const rows = await query(
    `SELECT employee_id, name, phone, email, role, status, language
       FROM employees WHERE ${column} = ?`,
    [value],
  );
  const employee = rows[0];
  if (!employee) return null;

  // Asked for by email but no email on file cannot happen — the lookup was
  // BY email. Asked for by phone or ID with no email is the normal case, and
  // the code goes by SMS.
  return { employee, channel };
}

export default function authRoutes(app) {
  /**
   * POST /auth/otp/request  { identifier }
   *
   * Always answers the same way, whether or not the person exists and
   * whatever their status. Telling an unauthenticated caller "no such
   * employee" would turn this box into a way to enumerate the contractor's
   * entire staff list, and confirming a number belongs to somebody is itself
   * a disclosure.
   */
  app.post('/auth/otp/request', otpRequestLimiter, async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Enter your phone number, email address or employee ID.',
      });
    }

    // The channel is derived from WHAT THE USER TYPED, never from the
    // record, so it can be returned safely: it tells a real user where to
    // look without telling an attacker whether the account exists.
    //
    // Note what is deliberately NOT here: the masked phone or email. Those
    // are only knowable from the record, so returning one would turn this
    // box into a contact-details lookup for anyone holding an employee ID.
    const typed = classifyIdentifier(parsed.data.identifier);
    const guessedChannel = typed?.kind === 'EMAIL' ? 'EMAIL' : 'SMS';

    const generic = {
      sent: true,
      channel: guessedChannel,
      message:
        guessedChannel === 'EMAIL'
          ? 'If that account exists, a code has been sent to that email address.'
          : 'If that account exists, a code has been sent by SMS.',
    };

    const resolved = await resolveEmployee(parsed.data.identifier);
    if (!resolved || resolved.employee.status === 'INACTIVE') {
      return res.json(generic);
    }

    const { employee, channel } = resolved;
    const code = String(randomInt(0, 10 ** config.otp.length)).padStart(
      config.otp.length,
      '0',
    );
    const expiresAt = new Date(Date.now() + config.otp.ttlMinutes * 60_000);

    // Any earlier unconsumed code is retired, so only the newest one works.
    await query(
      'UPDATE otp_codes SET consumed_at = NOW(3) WHERE employee_id = ? AND consumed_at IS NULL',
      [employee.employee_id],
    );
    await query(
      'INSERT INTO otp_codes (employee_id, code_hash, channel, expires_at) VALUES (?,?,?,?)',
      [employee.employee_id, hash(code, employee.employee_id), channel, expiresAt],
    );

    const destination = maskDestination(channel, employee.phone, employee.email);
    const { devCode } = await sendCode({
      channel,
      destination,
      code,
      employeeId: employee.employee_id,
      log: req.log,
    });

    // devCode exists only in log mode, which production refuses to start in.
    return res.json({ ...generic, ...(devCode ? { devCode } : {}) });
  });

  /**
   * POST /auth/otp/verify  { identifier, code, channel, device_id, device_label }
   *
   * On success this opens a session. On MOBILE that displaces any other
   * phone; on WEB it does not.
   */
  app.post('/auth/otp/verify', otpVerifyLimiter, async (req, res) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
        message: `Enter the ${config.otp.length}-digit code.`,
      });
    }

    const { code, channel, device_id: deviceId, device_label: deviceLabel } = parsed.data;

    const invalid = () =>
      res.status(401).json({
        error: 'INVALID_CODE',
        message: 'That code is wrong or has expired. Ask for a new one.',
      });

    const resolved = await resolveEmployee(parsed.data.identifier);
    if (!resolved || resolved.employee.status === 'INACTIVE') return invalid();
    const { employee } = resolved;

    const rows = await query(
      `SELECT id, code_hash, attempts, expires_at
         FROM otp_codes
        WHERE employee_id = ? AND consumed_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [employee.employee_id],
    );
    const otp = rows[0];
    if (!otp) return invalid();

    if (otp.attempts >= config.otp.maxAttempts) {
      await query('UPDATE otp_codes SET consumed_at = NOW(3) WHERE id = ?', [otp.id]);
      return res.status(429).json({
        error: 'TOO_MANY_ATTEMPTS',
        message: 'Too many wrong attempts. Ask for a new code.',
      });
    }

    if (new Date(`${otp.expires_at}Z`).getTime() < Date.now()) return invalid();

    const expected = Buffer.from(otp.code_hash, 'hex');
    const actual = Buffer.from(hash(code, employee.employee_id), 'hex');
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!ok) {
      await query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [otp.id]);
      return invalid();
    }

    await query('UPDATE otp_codes SET consumed_at = NOW(3) WHERE id = ?', [otp.id]);

    // FRD BR-WEB-1. Checked here rather than at every web endpoint so a
    // senior is told plainly at the door, not after a confusing half-login.
    if (channel === CHANNEL.WEB && !WEB_ROLES.includes(employee.role)) {
      return res.status(403).json({
        error: 'WEB_NOT_PERMITTED',
        message: 'The web portal is for administrators. Please use the Pramaan app.',
      });
    }

    const { sessionId, displaced } = await createSession({
      employeeId: employee.employee_id,
      channel,
      deviceId,
      deviceLabel,
    });

    // Role goes in the token from the master. It is never client-supplied.
    const token = signToken({
      sub: employee.employee_id,
      role: employee.role,
      sid: sessionId,
      ch: channel,
    });

    return res.json({
      token,
      session_id: sessionId,
      // So the new phone can say "we signed out your other device" rather
      // than the old one being the only place anybody finds out.
      displaced_devices: displaced.map((d) => ({
        device_label: d.device_label,
        signed_in_at: d.created_at,
      })),
      employee: {
        employee_id: employee.employee_id,
        name: employee.name,
        role: employee.role,
        status: employee.status,
        language: employee.language,
      },
      capabilities: capabilitiesFor(employee.role),
    });
  });

  /**
   * POST /auth/logout
   *
   * A real endpoint, not just the client forgetting its token. Without this
   * "signed out" would mean nothing on the server, and the phone would still
   * count as a live device.
   */
  app.post('/auth/logout', requireAuth, async (req, res) => {
    await endSession(req.session.session_id);
    res.json({ signed_out: true });
  });

  /** GET /auth/me — what the client renders. */
  app.get('/auth/me', requireAuth, async (req, res) => {
    res.json({
      employee: {
        employee_id: req.employee.employee_id,
        name: req.employee.name,
        role: req.employee.role,
        status: req.employee.status,
        language: req.employee.language,
      },
      capabilities: capabilitiesFor(req.employee.role),
      // True only while no SMS or email provider is configured (O-5).
      // Production refuses to start in that mode, so a real deployment
      // always reports false and the client's dev affordances disappear.
      dev_mode: config.otp.deliver === 'log',
      session: {
        session_id: req.session.session_id,
        channel: req.session.channel,
        device_label: req.session.device_label,
      },
      branding: config.branding,
    });
  });

  /**
   * GET /auth/sessions — your own devices.
   *
   * Mostly for the web, where several browsers may be signed in and an admin
   * needs to be able to sign out the one they left at a client's office.
   */
  app.get('/auth/sessions', requireAuth, async (req, res) => {
    const sessions = await listSessions(req.employee.employee_id);
    res.json({
      sessions: sessions.map((s) => ({
        ...s,
        current: s.session_id === req.session.session_id,
      })),
    });
  });

  /** POST /auth/sessions/:id/revoke — sign out one of your own devices. */
  app.post('/auth/sessions/:id/revoke', requireAuth, async (req, res) => {
    const target = await getSession(req.params.id);

    // Never confirm that somebody else's session id exists.
    if (!target || target.employee_id !== req.employee.employee_id) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No such session.' });
    }
    if (target.state === SESSION_STATE.REVOKED) {
      return res.json({ revoked: true, already: true });
    }

    await endSession(target.session_id);
    return res.json({ revoked: true, current: target.session_id === req.session.session_id });
  });
}
