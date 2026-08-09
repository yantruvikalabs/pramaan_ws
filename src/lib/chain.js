/**
 * The evidence chain — FRD §8.
 *
 * One chain for the whole tenant. Each event carries the hash of the one
 * before it and a `seq` that increments by exactly one, so removing any
 * record — or an entire employee's worth — breaks it visibly at that point.
 *
 * ⚠ APPEND-ONLY. Nothing in this file updates or deletes a row in `events`,
 * and nothing else may either. scripts/guard-append-only.mjs fails the build
 * on any attempt, for any role including Super Admin.
 *
 * ⚠ NO PERSONAL DATA (NFR-17). An event carries `subject_ref` and
 * `location_ref`, never an employee_id and never coordinates. A verifier can
 * check the whole chain without learning who anyone is or where they were,
 * and erasure after the retention period is a DELETE from a mapping table
 * that leaves the chain intact.
 */

import { createHash, randomUUID } from 'node:crypto';
import { EVENT_TYPES } from '@pramaan/shared';
import { canonicalBytes, CANON_VERSION } from './canonical.js';
import { sign, verify } from './signing.js';
import { getPool } from '../db.js';

export const GENESIS_HASH =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * The exact object that gets canonicalised, hashed and signed.
 *
 * Built here and nowhere else. If two code paths ever assemble this
 * differently, half the chain stops verifying and the cause is invisible.
 * Null fields are omitted by the canonical form (see canonical.js), so
 * adding an optional field later cannot change the bytes of an older event.
 */
export function envelopeOf(e) {
  return {
    canon_v: CANON_VERSION,
    seq: e.seq,
    event_id: e.event_id,
    type: e.type,
    subject_ref: e.subject_ref ?? undefined,
    device_ref: e.device_ref ?? undefined,
    session_ref: e.session_ref ?? undefined,
    location_ref: e.location_ref ?? undefined,
    payload: e.payload ?? {},
    captured_at: e.captured_at ?? undefined,
    received_at: e.received_at,
    device_time: e.device_time ?? undefined,
    uptime_ms: e.uptime_ms ?? undefined,
    prev_hash: e.prev_hash,
  };
}

/** ISO-8601 in UTC, to the millisecond. One format everywhere in the chain. */
const iso = (d) => new Date(d).toISOString();

/**
 * A MySQL DATETIME(3) string, back into the exact form that was signed.
 *
 * ⚠ Do not "simplify" this into string concatenation. That is what it was,
 * and it produced a bug worth understanding:
 *
 *   MySQL returns DATETIME(3) with trailing fractional zeros TRIMMED. A
 *   timestamp that happened to land on an exact second was stored as
 *   "…18:56:51.000" and read back as "…18:56:51". Rebuilding the string by
 *   hand then produced "2026-08-02T18:56:51Z" where "…51.000Z" had been
 *   signed — different bytes, different hash, and the event was reported as
 *   ALTERED for the rest of its life.
 *
 *   One event in a thousand. Roughly a 40% chance of appearing in any run of
 *   500, which is exactly often enough to look like flakiness and be
 *   dismissed, and exactly rare enough to reach production.
 *
 * Going through Date and back out via toISOString() re-normalises to three
 * decimal places always, which is the one format the chain uses.
 */
const fromMysql = (value) => (value ? new Date(`${value.replace(' ', 'T')}Z`).toISOString() : null);

/**
 * Append one event.
 *
 * Everything happens inside a transaction that holds a row lock on
 * chain_head, which is what makes `seq` gapless and `prev_hash` correct when
 * fifty phones upload at once. Deliberately NOT an AUTO_INCREMENT column: a
 * rolled-back transaction burns an auto-increment value and leaves a gap
 * that a verifier is right to read as a deleted record.
 *
 * @returns {{status:'appended'|'duplicate', event: object}}
 */
export async function appendEvent(input, conn = null) {
  const owned = conn === null;
  const c = conn ?? (await getPool().getConnection());

  try {
    if (owned) await c.beginTransaction();

    // Idempotency first — a phone may re-send freely and must always be
    // able to (BR-EVD-19). Checked inside the transaction so two concurrent
    // deliveries of the same event cannot both get past it.
    const [existing] = await c.execute(
      'SELECT * FROM events WHERE event_id = ?',
      [input.event_id],
    );
    if (existing.length > 0) {
      if (owned) await c.commit();
      return { status: 'duplicate', event: rowToEvent(existing[0]) };
    }

    const [heads] = await c.execute(
      'SELECT seq, hash FROM chain_head WHERE id = 1 FOR UPDATE',
    );
    const head = heads[0] ?? { seq: 0, hash: GENESIS_HASH };

    const event = {
      seq: Number(head.seq) + 1,
      event_id: input.event_id,
      type: input.type,
      subject_ref: input.subject_ref ?? null,
      device_ref: input.device_ref ?? null,
      session_ref: input.session_ref ?? null,
      location_ref: input.location_ref ?? null,
      payload: input.payload ?? {},
      captured_at: input.captured_at ? iso(input.captured_at) : null,
      received_at: iso(Date.now()),
      device_time: input.device_time ?? null,
      uptime_ms: input.uptime_ms ?? null,
      prev_hash: head.hash,
      canon_v: CANON_VERSION,
    };

    const bytes = canonicalBytes(envelopeOf(event));
    event.hash = sha256(bytes);
    event.signature = sign(bytes);

    await c.execute(
      `INSERT INTO events
         (seq, event_id, type, subject_ref, device_ref, session_ref, location_ref,
          payload, captured_at, received_at, device_time, uptime_ms,
          canon_v, prev_hash, hash, signature)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        event.seq, event.event_id, event.type, event.subject_ref, event.device_ref,
        event.session_ref, event.location_ref, JSON.stringify(event.payload),
        event.captured_at ? event.captured_at.slice(0, 23).replace('T', ' ') : null,
        event.received_at.slice(0, 23).replace('T', ' '),
        event.device_time, event.uptime_ms,
        event.canon_v, event.prev_hash, event.hash, event.signature,
      ],
    );

    await c.execute(
      'UPDATE chain_head SET seq = ?, hash = ? WHERE id = 1',
      [event.seq, event.hash],
    );

    if (owned) await c.commit();
    return { status: 'appended', event };
  } catch (err) {
    if (owned) await c.rollback();
    throw err;
  } finally {
    if (owned) c.release();
  }
}

/**
 * Hold a submission that cannot be appended. Never drop it. BR-EVD-20.
 *
 * "Quarantined WITH AN ALERT" — storing it silently is half the rule and the
 * less useful half. A row nobody is told about is a row nobody reads.
 *
 * The alert is a structured log line at error level with a fixed marker, so
 * any log shipper can page on it, plus a count surfaced on /health so it is
 * visible without one. Real paging (SMS, email) waits on O-5 like every
 * other outbound message in this product — that is a transport gap, not a
 * reason to leave the event silent.
 */
export async function quarantine(
  { eventId, reason, detail, submission, sessionRef },
  conn = null,
  log = null,
) {
  const c = conn ?? getPool();
  await c.execute(
    `INSERT INTO quarantine (event_id, reason, detail, submission, session_ref)
     VALUES (?,?,?,?,?)`,
    [eventId ?? null, reason, detail ?? null, JSON.stringify(submission ?? {}), sessionRef ?? null],
  );

  const alert = {
    alert: 'CHAIN_QUARANTINE',
    reason,
    event_id: eventId ?? null,
    session_ref: sessionRef ?? null,
    detail: detail ?? null,
  };
  // Deliberately not the submission body: it may contain anything a client
  // sent, and a log line is exactly where that must not end up.
  (log ?? console).error?.(alert, `chain quarantine: ${reason}`);
}

/** How many are waiting for somebody to look at them. */
export async function unreviewedQuarantine() {
  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS n FROM quarantine WHERE reviewed_at IS NULL',
  );
  return Number(rows[0]?.n ?? 0);
}

function rowToEvent(row) {
  return {
    seq: Number(row.seq),
    event_id: row.event_id,
    type: row.type,
    subject_ref: row.subject_ref,
    device_ref: row.device_ref,
    session_ref: row.session_ref,
    location_ref: row.location_ref,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    captured_at: fromMysql(row.captured_at),
    received_at: fromMysql(row.received_at),
    device_time: row.device_time,
    uptime_ms: row.uptime_ms === null ? null : Number(row.uptime_ms),
    canon_v: Number(row.canon_v),
    prev_hash: row.prev_hash,
    hash: row.hash,
    signature: row.signature,
  };
}

export { rowToEvent };

/** Is this a type the chain is allowed to carry? BR-EVD-17. */
export const isKnownType = (type) => EVENT_TYPES.includes(type);

export async function chainHead() {
  const pool = getPool();
  const [rows] = await pool.execute('SELECT seq, hash, updated_at FROM chain_head WHERE id = 1');
  const head = rows[0] ?? { seq: 0, hash: GENESIS_HASH };
  return { seq: Number(head.seq), hash: head.hash, updated_at: head.updated_at ?? null };
}

export async function readRange(fromSeq = 1, limit = 1000) {
  // LIMIT cannot be a placeholder in a MySQL prepared statement, so it is
  // coerced to a bounded integer and interpolated. Both values are forced
  // through Number and clamped first — nothing user-supplied reaches the SQL
  // as text.
  const from = Math.max(1, Math.floor(Number(fromSeq) || 1));
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 1000)), 50000);

  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT * FROM events WHERE seq >= ? ORDER BY seq ASC LIMIT ${take}`,
    [from],
  );
  return rows.map(rowToEvent);
}

/**
 * Walk the chain and report the FIRST place it breaks.
 *
 * Four things can be wrong and they are reported separately, because they
 * mean different things: a gap means a record was removed, a bad link means
 * one was altered, a bad hash means its content was altered, and a bad
 * signature means it was never ours.
 */
export async function verifyChain({ fromSeq = 1, limit = 100000 } = {}) {
  const events = await readRange(fromSeq, limit);
  if (events.length === 0) return { ok: true, checked: 0, from: fromSeq, to: fromSeq - 1 };

  let expectedSeq = events[0].seq;
  let expectedPrev = expectedSeq === 1 ? GENESIS_HASH : null;

  for (const e of events) {
    if (e.seq !== expectedSeq) {
      return fail(e, 'GAP', `expected seq ${expectedSeq}, found ${e.seq} — a record is missing`);
    }
    if (expectedPrev !== null && e.prev_hash !== expectedPrev) {
      return fail(e, 'BROKEN_LINK', `prev_hash does not match the hash of seq ${e.seq - 1}`);
    }

    const bytes = canonicalBytes(envelopeOf(e));
    const recomputed = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (recomputed !== e.hash) {
      return fail(e, 'ALTERED', 'the stored hash does not match the event content');
    }
    if (!verify(bytes, e.signature)) {
      return fail(e, 'BAD_SIGNATURE', 'the signature does not verify against the chain key');
    }

    expectedPrev = e.hash;
    expectedSeq += 1;
  }

  return {
    ok: true,
    checked: events.length,
    from: events[0].seq,
    to: events[events.length - 1].seq,
    head: events[events.length - 1].hash,
  };
}

const fail = (e, reason, detail) => ({
  ok: false,
  reason,
  detail,
  at_seq: e.seq,
  event_id: e.event_id,
});
