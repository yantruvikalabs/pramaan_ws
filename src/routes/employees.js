/**
 * Employee master — FRD FR-MST-001.
 *
 * Import is row-level (BR-MST-1): valid rows are created, invalid rows are
 * reported with the line number and the reason, and a bad row never fails
 * the batch. An admin importing 2,000 people must be told exactly which
 * lines were wrong and why.
 */

import { createHash, randomUUID } from 'node:crypto';
import { ROLE, ROLES, EMPLOYEE_STATUS, EVENT_TYPE, roleAtLeast } from '@pramaan/shared';
import { appendEvent } from '../lib/chain.js';
import { subjectRefFor } from '../lib/refs.js';
import {
  parseEmployeeCsv, validateImport, splitNewAndExisting, validateOneEmployee,
} from '../lib/import.js';
import { descendantsOf } from '../lib/tree.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { query, transaction } from '../db.js';

const CHUNK = 500;

/**
 * An import is a signed event — FRD BR-MST-6.
 *
 * It carries the file's hash and the counts, so a later question of "where
 * did these 2,000 people come from?" is answered by the chain rather than by
 * a table anyone with database access could edit.
 *
 * No personal data in the payload (NFR-17): counts and a hash, never names,
 * and the actor is an opaque reference like everybody else.
 */
async function recordImport({ batchId, actor, fileSha, source, fileName, totals }) {
  const { event } = await appendEvent({
    event_id: randomUUID(),
    type: EVENT_TYPE.EMPLOYEES_IMPORTED,
    subject_ref: null,          // an import is about the workforce, not a person
    payload: {
      batch_id: batchId,
      source,                   // CSV | MANUAL
      file_name: fileName ?? null,
      file_sha256: fileSha,
      total_rows: totals.total,
      created: totals.created,
      updated: totals.updated,
      rejected: totals.rejected,
      // BR-EVD-9: the actor and their role AT THAT MOMENT.
      actor_ref: await subjectRefFor(actor.employee_id),
      actor_role: actor.role,
    },
    captured_at: new Date().toISOString(),
  });
  return { seq: event.seq, hash: event.hash };
}

/**
 * Everyone already in the master, in the shape validateImport wants.
 *
 * Phone and email are login identifiers, so a clash has to be caught here
 * and reported by name — otherwise it surfaces as a MySQL duplicate-key
 * error, which tells an admin nothing they can act on.
 */
async function existingIdentifiers() {
  const rows = await query('SELECT employee_id, phone, email FROM employees');
  return {
    ids: new Set(rows.map((r) => r.employee_id)),
    phones: new Map(rows.map((r) => [r.phone, r.employee_id])),
    emails: new Map(rows.filter((r) => r.email).map((r) => [r.email, r.employee_id])),
  };
}

export default function employeeRoutes(app) {
  /**
   * POST /employees — add ONE person. FRD FR-MST-003.
   *
   * Importing a payroll list is how a contractor starts; this is how they
   * carry on. Somebody joins in March and nobody is going to re-upload two
   * thousand rows to add them.
   *
   * The rules are the importer's rules, not a second set — see
   * validateOneEmployee. A form and a spreadsheet disagreeing about what a
   * valid employee is would be its own support burden.
   */
  app.post('/employees', requireAuth, requireRole(ROLE.ADMIN), async (req, res) => {
    const body = typeof req.body === 'object' && req.body !== null ? req.body : {};

    const existing = await existingIdentifiers();

    // Creating, not updating. BR-MST-2 makes a repeated employee_id an
    // UPDATE during an import, but a "new employee" form that silently
    // overwrote a colleague would be a different and much worse thing.
    const employeeId = String(body.employee_id ?? '').trim();
    if (employeeId && existing.ids.has(employeeId)) {
      return res.status(409).json({
        error: 'ALREADY_EXISTS',
        message: `Employee "${employeeId}" already exists. Open them to make changes.`,
      });
    }

    // You cannot create somebody more powerful than yourself. Without this,
    // an ADMIN could mint a SUPER_ADMIN and sign in as them — which walks
    // straight around BR-ROL-5, where only a super admin manages roles.
    //
    // Only for roles that actually EXIST. A typo — "MANAGER" — is a
    // validation problem, and answering it with "you cannot create a
    // MANAGER, ask a super admin" sends the reader looking for a permission
    // they were never missing.
    const wantedRole = String(body.role ?? '').trim().toUpperCase();
    if (ROLES.includes(wantedRole) && !roleAtLeast(req.employee.role, wantedRole)) {
      return res.status(403).json({
        error: 'ROLE_TOO_HIGH',
        message: `You cannot create a ${wantedRole}. Ask a super admin.`,
      });
    }

    const check = validateOneEmployee(body, existing);
    if (!check.ok) {
      return res.status(400).json({
        error: 'INVALID_EMPLOYEE',
        message: check.errors[0],
        // Every problem at once. Fixing one field, resubmitting, and being
        // told about the next is how a four-field form takes four attempts.
        errors: check.errors,
      });
    }

    const e = check.employee;
    const batchId = randomUUID();

    await transaction(async (conn) => {
      await conn.execute(
        `INSERT INTO employees
           (employee_id, name, phone, email, role, reports_to, language, status)
         VALUES (?,?,?,?,?,?,?,?)`,
        [e.employee_id, e.name, e.phone, e.email, e.role, e.reports_to, e.language, e.status],
      );

      // The index row. The RECORD is the chain event written below —
      // BR-MST-6. This table stays because a report wants to page through
      // batches without walking the chain, but it is not the evidence.
      await conn.execute(
        `INSERT INTO import_batches
           (batch_id, imported_by, file_name, file_sha256,
            total_rows, accepted, rejected, report)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          batchId,
          req.employee.employee_id,
          null,
          createHash('sha256').update(JSON.stringify(e)).digest('hex'),
          1, 1, 0,
          JSON.stringify({ created: 1, updated: 0, source: 'MANUAL', rejected: [], warnings: [] }),
        ],
      );
    });

    // Into the chain, after the transaction commits. A person added to the
    // master with no event would be a person who appears in the attendance
    // record from nowhere.
    const chained = await recordImport({
      batchId,
      actor: req.employee,
      fileSha: createHash('sha256').update(JSON.stringify(e)).digest('hex'),
      source: 'MANUAL',
      totals: { total: 1, created: 1, updated: 0, rejected: 0 },
    });

    const [created] = await query(
      `SELECT employee_id, name, phone, email, role, reports_to, status, language
         FROM employees WHERE employee_id = ?`,
      [e.employee_id],
    );

    return res.status(201).json({ employee: created, batch_id: batchId, event: chained });
  });

  /**
   * POST /employees/import
   * Body: raw CSV, Content-Type: text/csv
   */
  app.post(
    '/employees/import',
    requireAuth,
    requireRole(ROLE.ADMIN),
    async (req, res) => {
      const text = typeof req.body === 'string' ? req.body : '';
      if (text.trim().length === 0) {
        return res.status(400).json({
          error: 'EMPTY_FILE',
          message: 'That file is empty. Choose a CSV with employee rows.',
        });
      }

      let parsed;
      try {
        parsed = parseEmployeeCsv(text);
      } catch (err) {
        return res.status(400).json({
          error: 'UNREADABLE_FILE',
          message: `That file could not be read as CSV: ${err.message}`,
        });
      }

      const existing = await existingIdentifiers();
      const existingIds = existing.ids;

      const result = validateImport(parsed.records, parsed.headers, existing);

      // A file-level problem — a banned column, a missing required column —
      // means no row in it is safe. This is the one case that fails a batch.
      if (result.fileError) {
        return res.status(400).json({ error: 'FILE_REJECTED', message: result.fileError });
      }

      const { created, updated } = splitNewAndExisting(result.accepted, existingIds);
      const fileSha = createHash('sha256').update(text, 'utf8').digest('hex');
      const batchId = randomUUID();

      if (result.accepted.length > 0) {
        await transaction(async (conn) => {
          // Pass 1: write everyone with reports_to NULL. The self-referencing
          // foreign key means a row cannot name a senior who is not in the
          // table yet — and a senior may appear further down the same file.
          for (let i = 0; i < result.accepted.length; i += CHUNK) {
            const chunk = result.accepted.slice(i, i + CHUNK);
            const placeholders = chunk.map(() => '(?,?,?,?,?,?,?)').join(',');
            const values = chunk.flatMap((r) => [
              r.employee_id, r.name, r.phone, r.email, r.role, r.language, r.status,
            ]);
            await conn.execute(
              `INSERT INTO employees
                 (employee_id, name, phone, email, role, language, status)
               VALUES ${placeholders}
               ON DUPLICATE KEY UPDATE
                 name = VALUES(name),
                 phone = VALUES(phone),
                 email = VALUES(email),
                 role = VALUES(role),
                 language = VALUES(language)`,
              // status is deliberately absent: re-importing must never
              // disturb an existing employee's enrolment. FRD BR-MST-2.
              values,
            );
          }

          // Pass 2: now that every id exists, attach the reporting lines.
          const withSenior = result.accepted.filter((r) => r.reports_to !== null);
          for (const row of withSenior) {
            await conn.execute(
              'UPDATE employees SET reports_to = ? WHERE employee_id = ?',
              [row.reports_to, row.employee_id],
            );
          }

          // BR-MST-6 requires this to be a signed event. Phase 2 turns it
          // into EmployeesImported in the chain; the fields are already here.
          await conn.execute(
            `INSERT INTO import_batches
               (batch_id, imported_by, file_name, file_sha256,
                total_rows, accepted, rejected, report)
             VALUES (?,?,?,?,?,?,?,?)`,
            [
              batchId,
              req.employee.employee_id,
              req.headers['x-file-name'] ?? null,
              fileSha,
              parsed.records.length,
              result.accepted.length,
              result.rejected.length,
              JSON.stringify({
                created: created.length,
                updated: updated.length,
                rejected: result.rejected,
                warnings: result.warnings,
              }),
            ],
          );
        });
      }

      const chained = result.accepted.length > 0
        ? await recordImport({
          batchId,
          actor: req.employee,
          fileSha,
          source: 'CSV',
          fileName: req.headers['x-file-name'] ?? null,
          totals: {
            total: parsed.records.length,
            created: created.length,
            updated: updated.length,
            rejected: result.rejected.length,
          },
        })
        : null;

      return res.json({
        batch_id: batchId,
        event: chained,
        file_sha256: fileSha,
        total_rows: parsed.records.length,
        created: created.length,
        updated: updated.length,
        rejected: result.rejected.length,
        // Every rejection, with its line number and reason. Never truncated —
        // an admin cannot fix what they are not shown.
        rejections: result.rejected,
        warnings: result.warnings,
      });
    },
  );

  /**
   * GET /employees
   *
   * An admin sees everyone. A senior sees only their own reporting chain,
   * direct and indirect — never the whole company. FRD BR-ROL-4.
   */
  app.get('/employees', requireAuth, async (req, res) => {
    const { role, employee_id: me } = req.employee;

    const all = await query(
      `SELECT employee_id, name, phone, email, role, reports_to, status, language
         FROM employees ORDER BY employee_id`,
    );

    if (role === ROLE.ADMIN || role === ROLE.SUPER_ADMIN) {
      return res.json({ employees: all, scope: 'ALL' });
    }

    const edges = new Map(all.map((e) => [e.employee_id, e.reports_to]));
    const visible = new Set(descendantsOf(me, edges));
    return res.json({
      employees: all.filter((e) => visible.has(e.employee_id)),
      scope: 'TEAM',
    });
  });

  /** GET /employees/:id — same visibility rule. */
  app.get('/employees/:id', requireAuth, async (req, res) => {
    const { role, employee_id: me } = req.employee;
    const targetId = req.params.id;

    const rows = await query(
      `SELECT employee_id, name, phone, email, role, reports_to, status, language
         FROM employees WHERE employee_id = ?`,
      [targetId],
    );
    const target = rows[0];
    if (!target) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No such employee.' });
    }

    if (role !== ROLE.ADMIN && role !== ROLE.SUPER_ADMIN && targetId !== me) {
      const all = await query('SELECT employee_id, reports_to FROM employees');
      const edges = new Map(all.map((e) => [e.employee_id, e.reports_to]));
      if (!descendantsOf(me, edges).includes(targetId)) {
        return res.status(403).json({
          error: 'FORBIDDEN',
          message: 'That employee is not in your team.',
        });
      }
    }

    return res.json({ employee: target });
  });

  /** GET /employees/import/batches — the import history. */
  app.get(
    '/employees/import/batches',
    requireAuth,
    requireRole(ROLE.ADMIN),
    async (_req, res) => res.json({
      batches: await query(
        `SELECT batch_id, imported_by, file_name, file_sha256,
                total_rows, accepted, rejected, created_at
           FROM import_batches ORDER BY created_at DESC LIMIT 50`,
      ),
    }),
  );

  /** Health of the master data — surfaces the gaps an admin must fix. */
  app.get(
    '/employees/health',
    requireAuth,
    requireRole(ROLE.ADMIN),
    async (_req, res) => {
      const [counts] = await query(
        `SELECT COUNT(*) AS total,
                SUM(status = ?) AS enrolment_pending,
                SUM(status = ?) AS enrolled,
                SUM(status = ?) AS inactive,
                SUM(reports_to IS NULL) AS no_senior
           FROM employees`,
        [EMPLOYEE_STATUS.ENROLMENT_PENDING, EMPLOYEE_STATUS.ENROLLED, EMPLOYEE_STATUS.INACTIVE],
      );
      return res.json({ counts });
    },
  );
}
