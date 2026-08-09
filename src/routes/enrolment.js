/**
 * Test enrolment — DEVELOPMENT ONLY.
 *
 * ⚠ Read this before extending anything here.
 *
 * Real enrolment is a FACE CAPTURE (FRD FR-ENR-001): three photographs of
 * the person standing in front of their senior, quality-gated, turned into
 * embeddings, images destroyed. It happens on a phone, in Phase 4, and it
 * **cannot happen in a browser** — BR-MST-19 says exactly that, because an
 * administrator marking somebody enrolled from a desk is asserting a
 * biometric they never saw.
 *
 * This endpoint exists for one reason: until the camera is built, every
 * employee is ENROLMENT_PENDING and nothing downstream of enrolment can be
 * exercised at all. It flips the status and writes a chain event that says,
 * permanently and in the signed record, that no face was checked.
 *
 * Three things keep it from becoming a hole in the product:
 *
 *   1. It refuses unless the server is in development mode — the same flag
 *      that prints OTPs to the log, and production refuses to start with it.
 *   2. The event it writes carries `method: TEST_NO_BIOMETRIC`, inside the
 *      signed envelope, so a test enrolment can never be mistaken for a real
 *      one in any export, report or dispute.
 *   3. It records WHO did it (BR-ENR-11), like a real enrolment would.
 *
 * When Phase 4 lands, delete this file. Do not "upgrade" it.
 */

import { randomUUID } from 'node:crypto';
import { EMPLOYEE_STATUS, EVENT_TYPE, ROLE } from '@pramaan/shared';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { appendEvent } from '../lib/chain.js';
import { subjectRefFor } from '../lib/refs.js';
import { query } from '../db.js';
import { config } from '../config.js';

/** The same gate as the OTP-in-the-log. Production cannot reach this. */
function devOnly(req, res, next) {
  if (config.otp.deliver !== 'log' || config.env === 'production') {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: 'No such endpoint.',
    });
  }
  return next();
}

export default function enrolmentRoutes(app) {
  /**
   * POST /employees/:id/enrolment  — mark somebody registered, for testing.
   *
   * SENIOR and above, matching who may enrol in the real flow (FR-ENR-002:
   * the contractor's own supervisors run enrolment, because us doing it for
   * 2,000 people is the thing that does not scale).
   */
  app.post(
    '/employees/:id/enrolment',
    devOnly,
    requireAuth,
    requireRole(ROLE.SENIOR),
    async (req, res) => {
      const employeeId = req.params.id;

      const rows = await query(
        'SELECT employee_id, name, status FROM employees WHERE employee_id = ?',
        [employeeId],
      );
      const employee = rows[0];
      if (!employee) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'No such employee.' });
      }
      if (employee.status === EMPLOYEE_STATUS.INACTIVE) {
        return res.status(409).json({
          error: 'INACTIVE',
          message: 'That employee is inactive. Reactivate them first.',
        });
      }
      if (employee.status === EMPLOYEE_STATUS.ENROLLED) {
        return res.status(409).json({
          error: 'ALREADY_ENROLLED',
          message: `${employee.name} is already registered.`,
        });
      }

      // The event first. If the chain write fails the status must not change,
      // or the master would claim an enrolment the record does not contain.
      const { event } = await appendEvent({
        event_id: randomUUID(),
        type: EVENT_TYPE.ENROLLED,
        subject_ref: await subjectRefFor(employeeId),
        session_ref: req.session.session_id,
        payload: {
          // The whole point. Permanent, inside the signature, unmissable.
          method: 'TEST_NO_BIOMETRIC',
          note: 'Development fixture. No face was captured and no template exists.',
          templates: 0,
          // BR-ENR-11: who performed it, and their role AT THAT MOMENT.
          // Authority is never re-derived later.
          actor_ref: await subjectRefFor(req.employee.employee_id),
          actor_role: req.employee.role,
        },
        captured_at: new Date().toISOString(),
      });

      await query('UPDATE employees SET status = ? WHERE employee_id = ?', [
        EMPLOYEE_STATUS.ENROLLED,
        employeeId,
      ]);

      return res.status(201).json({
        employee_id: employeeId,
        status: EMPLOYEE_STATUS.ENROLLED,
        event: { seq: event.seq, hash: event.hash },
        warning: 'TEST ENROLMENT — no face was captured. Development only.',
      });
    },
  );

  /**
   * DELETE /employees/:id/enrolment — put them back, for testing again.
   *
   * No chain event, deliberately, and no production equivalent: un-enrolling
   * is not a thing this product does. A person whose face needs re-capturing
   * is re-enrolled, which is a new Enrolled event superseding the old one —
   * both remain. This is a test fixture and nothing more.
   */
  app.delete(
    '/employees/:id/enrolment',
    devOnly,
    requireAuth,
    requireRole(ROLE.SENIOR),
    async (req, res) => {
      const result = await query(
        'UPDATE employees SET status = ? WHERE employee_id = ? AND status = ?',
        [EMPLOYEE_STATUS.ENROLMENT_PENDING, req.params.id, EMPLOYEE_STATUS.ENROLLED],
      );
      return res.json({
        employee_id: req.params.id,
        status: EMPLOYEE_STATUS.ENROLMENT_PENDING,
        changed: result.affectedRows > 0,
      });
    },
  );
}
