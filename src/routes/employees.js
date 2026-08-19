/**
 * Employee master — FRD FR-MST-001.
 *
 * Import is row-level (BR-MST-1): valid rows are created, invalid rows are
 * reported with the line number and the reason, and a bad row never fails
 * the batch. An admin importing 2,000 people must be told exactly which
 * lines were wrong and why.
 */

import { createHash, randomUUID } from 'node:crypto';
import { ROLE, ROLES, EMPLOYEE_STATUS, EVENT_TYPE, roleAtLeast } from '../lib/vocabulary.js';
import { appendEvent } from '../lib/chain.js';
import { subjectRefFor } from '../lib/refs.js';
import {
  parseEmployeeCsv, validateImport, splitNewAndExisting, validateOneEmployee,
} from '../lib/import.js';
import { descendantsOf } from '../lib/tree.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { col, getClient, CHAIN_TXN_OPTIONS } from '../db/mongo.js';
import { toEmployee } from '../lib/employee-store.js';

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
  const rows = await col('employees')
    .find({}, { projection: { phone: 1, email: 1 } })
    .toArray();
  return {
    ids: new Set(rows.map((r) => r._id)),
    phones: new Map(rows.map((r) => [r.phone, r._id])),
    emails: new Map(rows.filter((r) => r.email).map((r) => [r.email, r._id])),
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

    const session = getClient().startSession();
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        await col('employees').insertOne({
          _id: e.employee_id,
          name: e.name,
          phone: e.phone,
          email: e.email,
          role: e.role,
          reports_to: e.reports_to,
          language: e.language,
          status: e.status,
          created_at: now,
          updated_at: now,
        }, { session });

        // The index row. The RECORD is the chain event written below —
        // BR-MST-6. This collection stays because a report wants to page
        // through batches without walking the chain, but it is not the evidence.
        await col('import_batches').insertOne({
          _id: batchId,
          imported_by: req.employee.employee_id,
          file_name: null,
          file_sha256: createHash('sha256').update(JSON.stringify(e)).digest('hex'),
          total_rows: 1,
          accepted: 1,
          rejected: 0,
          report: { created: 1, updated: 0, source: 'MANUAL', rejected: [], warnings: [] },
          created_at: now,
        }, { session });
      }, CHAIN_TXN_OPTIONS);
    } finally {
      await session.endSession();
    }

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

    const created = toEmployee(await col('employees').findOne({ _id: e.employee_id }));

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
        const session = getClient().startSession();
        try {
          await session.withTransaction(async () => {
            // ⚠ $set of NAMED FIELDS, with status in $setOnInsert. Never a
            //   whole-document replace, and never $set on status.
            //
            //   The MySQL statement listed exactly five columns in ON DUPLICATE
            //   KEY UPDATE and omitted `status` on purpose (FRD BR-MST-2):
            //   re-importing the payroll file must never disturb an existing
            //   employee's enrolment. A replaceOne/upsert — the obvious port —
            //   resets status to its default, turning every ENROLLED worker
            //   back into ENROLMENT_PENDING and refusing them at the gate at
            //   dawn, with no error anywhere.
            //
            //   reports_to is set only when the file names one, matching the
            //   old two-pass behaviour where a null in the CSV left an existing
            //   reporting line alone. The two passes themselves are gone: they
            //   existed to satisfy a self-referencing foreign key that a row
            //   could not violate before its senior was inserted, and there is
            //   no such constraint now.
            const now = new Date();
            const ops = result.accepted.map((r) => {
              const set = {
                name: r.name,
                phone: r.phone,
                email: r.email,
                role: r.role,
                language: r.language,
                updated_at: now,
              };
              const setOnInsert = { status: r.status, created_at: now };

              // A field may not appear in both operators.
              if (r.reports_to !== null) set.reports_to = r.reports_to;
              else setOnInsert.reports_to = null;

              return {
                updateOne: {
                  filter: { _id: r.employee_id },
                  update: { $set: set, $setOnInsert: setOnInsert },
                  upsert: true,
                },
              };
            });

            for (let i = 0; i < ops.length; i += CHUNK) {
              await col('employees').bulkWrite(ops.slice(i, i + CHUNK), { ordered: true, session });
            }

            // BR-MST-6 requires this to be a signed event. Phase 2 turns it
            // into EmployeesImported in the chain; the fields are already here.
            await col('import_batches').insertOne({
              _id: batchId,
              imported_by: req.employee.employee_id,
              file_name: req.headers['x-file-name'] ?? null,
              file_sha256: fileSha,
              total_rows: parsed.records.length,
              accepted: result.accepted.length,
              rejected: result.rejected.length,
              report: {
                created: created.length,
                updated: updated.length,
                rejected: result.rejected,
                warnings: result.warnings,
              },
              created_at: now,
            }, { session });
          }, CHAIN_TXN_OPTIONS);
        } finally {
          await session.endSession();
        }
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

    const all = (await col('employees').find({}).sort({ _id: 1 }).toArray()).map(toEmployee);

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

  /** GET /employees/import/batches — the import history. */
  app.get(
    '/employees/import/batches',
    requireAuth,
    requireRole(ROLE.ADMIN),
    async (_req, res) => res.json({
      batches: (await col('import_batches')
        .find({}, { projection: { report: 0 } })
        .sort({ created_at: -1 })
        .limit(50)
        .toArray()).map(({ _id, ...b }) => ({ batch_id: _id, ...b })),
    }),
  );

  /** Health of the master data — surfaces the gaps an admin must fix. */
  app.get(
    '/employees/health',
    requireAuth,
    requireRole(ROLE.ADMIN),
    async (_req, res) => {
      const [counts] = await col('employees').aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            enrolment_pending: { $sum: { $cond: [{ $eq: ['$status', EMPLOYEE_STATUS.ENROLMENT_PENDING] }, 1, 0] } },
            enrolled: { $sum: { $cond: [{ $eq: ['$status', EMPLOYEE_STATUS.ENROLLED] }, 1, 0] } },
            inactive: { $sum: { $cond: [{ $eq: ['$status', EMPLOYEE_STATUS.INACTIVE] }, 1, 0] } },
            no_senior: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$reports_to', null] }, null] }, 1, 0] } },
          },
        },
        { $project: { _id: 0 } },
      ]).toArray();
      return res.json({
        counts: counts ?? {
          total: 0, enrolment_pending: 0, enrolled: 0, inactive: 0, no_senior: 0,
        },
      });
    },
  );

  /** GET /employees/:id — same visibility rule. */
  app.get('/employees/:id', requireAuth, async (req, res) => {
    const { role, employee_id: me } = req.employee;
    const targetId = req.params.id;

    const target = toEmployee(await col('employees').findOne({ _id: targetId }));
    if (!target) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No such employee.' });
    }

    if (role !== ROLE.ADMIN && role !== ROLE.SUPER_ADMIN && targetId !== me) {
      const all = await col('employees').find({}, { projection: { reports_to: 1 } }).toArray();
      const edges = new Map(all.map((e) => [e._id, e.reports_to]));
      if (!descendantsOf(me, edges).includes(targetId)) {
        return res.status(403).json({
          error: 'FORBIDDEN',
          message: 'That employee is not in your team.',
        });
      }
    }

    return res.json({ employee: target });
  });
}
