/**
 * The MongoDB schema — replaces db/schema.sql.
 *
 * Read schema.sql alongside this file: it records WHY each constraint exists,
 * and every one of those reasons still applies. What changes is who enforces
 * them. Three categories are worth naming explicitly, because two of them
 * quietly move from the database into application code.
 *
 * 1. UNIQUE INDEXES — still enforced by the database. `event_id` is the
 *    idempotency key that lets a phone re-send freely (BR-EVD-19); `phone` is
 *    "one number is one person"; `(employee_id, capture_index)` is three
 *    templates per person, never averaged.
 *
 * 2. ENUMS → JSON-Schema validators. MySQL could not store a value outside the
 *    list. A validator can, if somebody writes through a path that bypasses it
 *    or if validation is later relaxed — so code that reads these fields must
 *    assert positively (`state === ACTIVE`) rather than by exclusion.
 *
 * 3. FOREIGN KEYS — GONE. There is no equivalent. `fk_employees_reports_to`
 *    was ON DELETE RESTRICT specifically so deactivating an employee could
 *    never remove anybody (schema.sql:61). That guarantee is now the
 *    application's, and `assertReferentialIntegrity()` below is what checks it
 *    — a check that must actually be run, not merely exist.
 *
 * ⚠ `events` is APPEND-ONLY (BR-EVD-12). It must never have a TTL index and
 *   must never be capped: both delete documents silently, with no code to
 *   review and no trace. `assertEventsCollectionSafe()` fails startup if
 *   either appears.
 */

import { col, getDb } from './mongo.js';

export const GENESIS_HASH =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';

export const HEAD_ID = 'HEAD';

const enumOf = (...values) => ({ enum: values });

/**
 * Collection definitions. `validator` is applied with moderate strictness:
 * it enforces the value sets that used to be ENUMs, and deliberately does NOT
 * enumerate every field, because a schema that must be edited for every new
 * optional field becomes a schema people disable.
 */
export const COLLECTIONS = {
  employees: {
    // _id IS employee_id — the natural key, imported from the contractor's
    // payroll list. A separate ObjectId would add a second identity for the
    // same person and an index to maintain, for nothing.
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'name', 'phone', 'role', 'status', 'language'],
        properties: {
          _id: { bsonType: 'string' },
          name: { bsonType: 'string' },
          phone: { bsonType: 'string' },
          email: { bsonType: ['string', 'null'] },
          role: enumOf('EMPLOYEE', 'SENIOR', 'ADMIN', 'SUPER_ADMIN'),
          reports_to: { bsonType: ['string', 'null'] },
          status: enumOf('ENROLMENT_PENDING', 'ENROLLED', 'INACTIVE'),
          language: { bsonType: 'string' },
        },
      },
    },
    indexes: [
      { key: { phone: 1 }, name: 'uq_employees_phone', unique: true },
      // ⚠ partialFilterExpression is REQUIRED here and has no MySQL analogue.
      //   MySQL permits repeated NULLs in a unique index, which is exactly what
      //   we want: most of the workforce — cleaners, guards, food handlers —
      //   has no email address. MongoDB treats a missing field as a value and
      //   would reject the SECOND employee without an email. Restricting the
      //   index to documents where email is a string restores MySQL's meaning.
      {
        key: { email: 1 },
        name: 'uq_employees_email',
        unique: true,
        partialFilterExpression: { email: { $type: 'string' } },
      },
      { key: { reports_to: 1 }, name: 'idx_employees_reports_to' },
      { key: { role: 1 }, name: 'idx_employees_role' },
      { key: { status: 1 }, name: 'idx_employees_status' },
    ],
  },

  otp_codes: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['employee_id', 'code_hash', 'channel', 'expires_at'],
        properties: {
          employee_id: { bsonType: 'string' },
          code_hash: { bsonType: 'string' },
          channel: enumOf('SMS', 'EMAIL'),
          expires_at: { bsonType: 'date' },
          attempts: { bsonType: 'int' },
          consumed_at: { bsonType: ['date', 'null'] },
        },
      },
    },
    indexes: [
      { key: { employee_id: 1, consumed_at: 1, created_at: -1 }, name: 'idx_otp_employee' },
      // A TTL index is CORRECT here and forbidden on `events`. One-time codes
      // are ephemeral by definition; the chain is the opposite.
      { key: { expires_at: 1 }, name: 'idx_otp_expiry', expireAfterSeconds: 86_400 },
    ],
  },

  sessions: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'employee_id', 'channel', 'state', 'last_seen_at'],
        properties: {
          _id: { bsonType: 'string' },                    // session_id (uuid)
          employee_id: { bsonType: 'string' },
          channel: enumOf('MOBILE', 'WEB'),
          state: enumOf('ACTIVE', 'DRAIN_ONLY', 'REVOKED'),
          reason: {
            oneOf: [
              enumOf('SIGNED_OUT', 'SIGNED_IN_ELSEWHERE', 'DEACTIVATED', 'EXPIRED'),
              { bsonType: 'null' },
            ],
          },
          last_seen_at: { bsonType: 'date' },
        },
      },
    },
    indexes: [
      { key: { employee_id: 1, channel: 1, state: 1 }, name: 'idx_sessions_employee' },
      { key: { last_seen_at: 1 }, name: 'idx_sessions_last_seen' },
    ],
  },

  import_batches: {
    indexes: [{ key: { created_at: -1 }, name: 'idx_import_created' }],
  },

  subject_refs: {
    // MUTABLE and DELETABLE on purpose (NFR-17): deleting a row here makes
    // every event about that person anonymous while the chain still verifies.
    indexes: [{ key: { employee_id: 1 }, name: 'uq_subject_employee', unique: true }],
  },

  location_fixes: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        properties: {
          // A real boolean, not TINYINT(1). Every read must use Boolean(),
          // never `=== 1` — see lib/refs.js toLocation().
          is_mock: { bsonType: 'bool' },
          lat: { bsonType: ['double', 'int', 'null'] },
          lon: { bsonType: ['double', 'int', 'null'] },
        },
      },
    },
    indexes: [],
  },

  events: {
    // ⚠ APPEND-ONLY. _id IS seq, so two events cannot occupy one position even
    //   if the head compare-and-swap has a bug — the second insert fails on the
    //   primary key. It also makes the seq-ordered read an index scan for free.
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'seq', 'event_id', 'type', 'payload',
                   'received_at', 'canon_v', 'prev_hash', 'hash', 'signature'],
        properties: {
          // `double` is included deliberately. The Node driver serialises a JS
          // integer as int32 only while it fits; past 2^31-1 it becomes a
          // double, so a stricter list would reject every append beyond ~2.1
          // billion events with a validation error. Integer-ness is enforced
          // where it can be enforced properly: appendOnce() refuses a head seq
          // that is not a safe integer, and canonical.js refuses to sign any
          // non-integer at all.
          _id: { bsonType: ['int', 'long', 'double'] },
          seq: { bsonType: ['int', 'long', 'double'] },
          event_id: { bsonType: 'string' },
          type: { bsonType: 'string' },
          // Timestamps are stored as the EXACT ISO STRINGS THAT WERE SIGNED.
          // Not dates. Converting them is how a chain gets silently shifted by
          // a timezone offset and every event reads ALTERED, unfixably.
          received_at: { bsonType: 'string' },
          captured_at: { bsonType: ['string', 'null'] },
          prev_hash: { bsonType: 'string' },
          hash: { bsonType: 'string' },
          signature: { bsonType: 'string' },
        },
      },
    },
    indexes: [
      { key: { event_id: 1 }, name: 'uq_events_event_id', unique: true },
      { key: { hash: 1 }, name: 'uq_events_hash', unique: true },
      { key: { subject_ref: 1, seq: 1 }, name: 'idx_events_subject' },
      { key: { type: 1, seq: 1 }, name: 'idx_events_type' },
      { key: { received_at_d: 1 }, name: 'idx_events_received' },
    ],
  },

  chain_head: {
    // Exactly one document, _id fixed. Never upserted on a variable filter:
    // a drifting filter creates a SECOND head and two appenders chain off
    // different ones. This replaces CHECK (id = 1).
    indexes: [],
  },

  published_heads: {
    indexes: [{ key: { seq: 1 }, name: 'idx_published_seq' }],
  },

  quarantine: {
    indexes: [{ key: { reason: 1, received_at: 1 }, name: 'idx_quarantine_reason' }],
  },

  face_templates: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['employee_id', 'capture_index', 'model', 'dimensions', 'embedding', 'channel'],
        properties: {
          employee_id: { bsonType: 'string' },
          capture_index: { bsonType: 'int' },
          model: { bsonType: 'string' },
          dimensions: { bsonType: 'int' },
          // ⚠ NO IMAGE, EVER (BR-ENR-2). This is a little-endian float64
          //   vector and there is no column for a picture anywhere.
          embedding: { bsonType: 'binData' },
          channel: enumOf('WEB', 'PHONE'),
        },
      },
    },
    indexes: [
      { key: { employee_id: 1, capture_index: 1 }, name: 'uq_template_capture', unique: true },
      { key: { employee_id: 1 }, name: 'idx_template_employee' },
    ],
  },
};

/** Create collections, validators and indexes. Idempotent. */
export async function applySchema({ log = console } = {}) {
  const db = getDb();
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    const options = spec.validator
      ? { validator: spec.validator, validationLevel: 'moderate', validationAction: 'error' }
      : {};

    if (!existing.has(name)) {
      await db.createCollection(name, options);
    } else if (spec.validator) {
      // collMod, because createCollection on an existing collection throws and
      // a validator added after the fact is the normal case on redeploy.
      await db.command({ collMod: name, ...options });
    }

    for (const index of spec.indexes ?? []) {
      const { key, ...opts } = index;
      await db.collection(name).createIndex(key, opts);
    }
  }

  await col('chain_head').updateOne(
    { _id: HEAD_ID },
    { $setOnInsert: { seq: 0, hash: GENESIS_HASH, updated_at: new Date() } },
    { upsert: true },
  );

  log.log?.(`✓ schema applied to "${db.databaseName}" — ${Object.keys(COLLECTIONS).length} collections`);
}

/**
 * The chain must not be silently deletable.
 *
 * A TTL index and a capped collection both remove documents with no code to
 * review, no audit trail and no error — the two ways MongoDB can break
 * BR-EVD-12 without anybody writing a delete. Checked at startup because a
 * source-code guard cannot see either of them.
 */
export async function assertEventsCollectionSafe() {
  const db = getDb();

  const [info] = await db.listCollections({ name: 'events' }).toArray();
  if (info?.options?.capped) {
    throw new Error(
      'the `events` collection is CAPPED — it silently drops the oldest records. ' +
      'The evidence chain is append-only and must never lose a record (BR-EVD-12).',
    );
  }

  const indexes = await db.collection('events').indexes();
  const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
  if (ttl) {
    throw new Error(
      `the \`events\` collection has a TTL index (${ttl.name}) — it deletes records ` +
      'on a timer, invisibly. The evidence chain is append-only (BR-EVD-12).',
    );
  }

  return { capped: false, ttl: false, indexes: indexes.length };
}

/**
 * What the foreign keys used to guarantee.
 *
 * MySQL made these impossible; MongoDB cannot. Run it after an import and in
 * the health check — an integrity constraint nobody evaluates is a comment.
 */
export async function assertReferentialIntegrity() {
  const problems = [];

  const orphanManagers = await col('employees').aggregate([
    { $match: { reports_to: { $ne: null } } },
    { $lookup: { from: 'employees', localField: 'reports_to', foreignField: '_id', as: 'manager' } },
    { $match: { manager: { $size: 0 } } },
    { $project: { _id: 1, reports_to: 1 } },
  ]).toArray();
  if (orphanManagers.length > 0) {
    problems.push({
      constraint: 'fk_employees_reports_to',
      detail: `${orphanManagers.length} employee(s) report to somebody who does not exist`,
      examples: orphanManagers.slice(0, 5),
    });
  }

  for (const [collection, constraint] of [['sessions', 'fk_sessions_employee'],
                                          ['otp_codes', 'fk_otp_employee']]) {
    const orphans = await col(collection).aggregate([
      { $lookup: { from: 'employees', localField: 'employee_id', foreignField: '_id', as: 'e' } },
      { $match: { e: { $size: 0 } } },
      { $count: 'n' },
    ]).toArray();
    if (orphans[0]?.n > 0) {
      problems.push({ constraint, detail: `${orphans[0].n} ${collection} row(s) name a missing employee` });
    }
  }

  return { ok: problems.length === 0, problems };
}
