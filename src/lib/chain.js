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
import { col, getClient, CHAIN_TXN_OPTIONS } from '../db/mongo.js';
import { HEAD_ID } from '../db/mongo-schema.js';
import { assertBsonSafe } from './bson-safe.js';

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
 *
 * ⚠ Used ONLY by rowToEvent(), which now exists only for the migration tool.
 *   The live read path is docToEvent(), and MongoDB stores these timestamps as
 *   the exact ISO strings that were signed — deleting this conversion from the
 *   running system rather than porting it, and with it the whole class of bug
 *   described above.
 */
const fromMysql = (value) => (value ? new Date(`${value.replace(' ', 'T')}Z`).toISOString() : null);

/**
 * We lost the race for this position. Not an error condition — retry.
 *
 * MySQL had no equivalent: `SELECT ... FOR UPDATE` on chain_head QUEUED
 * concurrent appenders, so only one was ever inside the critical section.
 * MongoDB has no row lock, so contention surfaces here instead of being
 * absorbed by the database.
 */
class ChainRaceError extends Error {
  constructor(seq) { super(`chain head moved past ${seq}`); this.name = 'ChainRaceError'; }
}

const isTransient = (err) =>
  err?.hasErrorLabel?.('TransientTransactionError') ||
  err?.hasErrorLabel?.('UnknownTransactionCommitResult') ||
  err?.codeName === 'WriteConflict' || err?.code === 112;

const isDuplicateKey = (err) => err?.code === 11000;

/**
 * An in-process queue in front of the appender — THROUGHPUT ONLY.
 *
 * Measured in D2: with 50 appends in flight the compare-and-swap loses often
 * enough that each transaction body runs 8.86 times, and every run re-signs
 * (the signature covers prev_hash, which changes on each retry, so the work
 * cannot be hoisted out). Throughput fell from 104/s to 31/s while MySQL's row
 * lock held a flat ~210/s, because InnoDB QUEUES contenders where MongoDB
 * ABORTS them. Serialising locally turns that contention back into a queue.
 *
 * ⚠ NOT a correctness mechanism. It is confined to one Node process and
 *   disappears during a rolling restart or with a second worker. The
 *   compare-and-swap below is the guarantee, and test/chain-concurrency.mjs
 *   runs every correctness pass with this queue DISABLED.
 */
let appendQueue = Promise.resolve();

function serialise(fn) {
  const run = appendQueue.then(fn, fn);
  appendQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Append one event.
 *
 * @param {object} input
 * @param {import('mongodb').ClientSession|null} session
 *   Passed only by a caller that owns an outer transaction. When it is, we do
 *   NOT retry: the outer transaction is the unit of retry, and re-signing an
 *   event into a transaction that is already doomed would be wrong.
 * @param {{queue?: boolean, maxAttempts?: number, stats?: object}} opts
 */
export async function appendEvent(input, session = null, opts = {}) {
  if (session !== null) return appendOnce(input, session, opts);
  if (opts.queue === false) return appendWithRetry(input, opts);
  return serialise(() => appendWithRetry(input, opts));
}

async function appendWithRetry(input, opts = {}) {
  const { maxAttempts = 25, stats = null } = opts;
  const client = getClient();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const session = client.startSession();
    try {
      let result = null;
      await session.withTransaction(async () => {
        result = await appendOnce(input, session, opts);
      }, CHAIN_TXN_OPTIONS);
      return result;
    } catch (err) {
      // Losing the race consumes nothing — the whole transaction rolled back,
      // so no seq was burned. Retrying is correct behaviour, not a workaround.
      if (err instanceof ChainRaceError || isTransient(err) || isDuplicateKey(err)) {
        if (stats !== null) stats.retries = (stats.retries ?? 0) + 1;

        // A duplicate event_id that was not visible at step 1 means a
        // concurrent delivery of the SAME event won. That is a duplicate, not
        // an error (BR-EVD-19) — throwing would fail an entire ingest batch
        // for a punch that is perfectly fine.
        if (isDuplicateKey(err)) {
          const existing = await col('events').findOne({ event_id: input.event_id });
          if (existing) return { status: 'duplicate', event: docToEvent(existing) };
        }
        if (attempt === maxAttempts) {
          throw new Error(`append failed after ${maxAttempts} attempts: ${err.message}`);
        }
        // Jittered: without it, N appenders retry in lockstep and collide again.
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4 * attempt) + 1));
        continue;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }
  throw new Error('unreachable');
}

async function appendOnce(input, session, opts = {}) {
  if (opts.stats) opts.stats.bodyRuns = (opts.stats.bodyRuns ?? 0) + 1;

  const events = col('events');
  const heads = col('chain_head');

  // 1 ── Idempotency first. A phone that lost signal mid-upload must always be
  //      free to send everything again (BR-EVD-19).
  const existing = await events.findOne({ event_id: input.event_id }, { session });
  if (existing) return { status: 'duplicate', event: docToEvent(existing) };

  // 2 ── The head is a CLAIM, not a fact: true only if the swap in step 4 matches.
  const head = (await heads.findOne({ _id: HEAD_ID }, { session }))
            ?? { seq: 0, hash: GENESIS_HASH };
  const prevSeq = Number(head.seq);
  if (!Number.isSafeInteger(prevSeq)) {
    throw new Error(`chain head seq is not a safe integer: ${head.seq}`);
  }

  const event = {
    seq: prevSeq + 1,
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

  // 3 ── Refuse what BSON cannot hold faithfully, BEFORE signing. D1 proved a
  //      lone surrogate is silently replaced with U+FFFD; such an event would
  //      read as ALTERED forever. It must be quarantined, never rewritten.
  assertBsonSafe(event.payload, '$.payload');

  const bytes = canonicalBytes(envelopeOf(event));
  event.hash = sha256(bytes);
  event.signature = sign(bytes);

  // A test hook, and deliberately a narrow one: a boolean that throws at a
  // single fixed point, not a caller-supplied callback that could do anything.
  // It exists so test/chain-concurrency.mjs can prove the property that matters
  // most — that a crash between signing and commit burns NO seq — against the
  // real appender rather than a copy of it. No route passes this.
  if (opts.failAfterSign) throw new Error('simulated crash between signing and commit');

  // 4 ── THE LOCK. Conditional on the head not having moved since step 2.
  //      matchedCount 0 means somebody else took this position.
  const swap = await heads.updateOne(
    { _id: HEAD_ID, seq: prevSeq },
    { $set: { seq: event.seq, hash: event.hash, updated_at: new Date() } },
    { session, upsert: false },
  );
  if (swap.matchedCount !== 1) throw new ChainRaceError(prevSeq);

  // 5 ── _id IS seq: two events cannot occupy one position even if the swap
  //      above is wrong. The second insert fails on the primary key.
  await events.insertOne(toDoc(event), { session });

  return { status: 'appended', event };
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
  await col('quarantine').insertOne({
    event_id: eventId ?? null,
    reason,
    detail: detail ?? null,
    submission: submission ?? {},
    session_ref: sessionRef ?? null,
    received_at: new Date(),
    reviewed_at: null,
  }, conn ? { session: conn } : {});

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
  return col('quarantine').countDocuments({ reviewed_at: null });
}

/**
 * A MySQL ROW → an event. Retained for tools/migrate-to-mongo.mjs only.
 *
 * The application no longer reads MySQL; do not use this on the live path.
 * It is what makes the migration's byte-equality check meaningful, because it
 * is the same mapper the application used when those events were written.
 */
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

/**
 * An event → its stored document.
 *
 * `_id` IS seq: two events cannot occupy one position even if the head
 * compare-and-swap is wrong, because the second insert fails on the primary
 * key. It also makes the seq-ordered read an index scan for free.
 *
 * ⚠ captured_at / received_at are stored as the EXACT ISO STRINGS THAT WERE
 *   SIGNED, not as dates. The parallel `_d` fields exist for querying and are
 *   never canonicalised. Storing these as BSON Dates and formatting them back
 *   on read is how a whole chain silently shifts by a timezone offset and
 *   every event reports ALTERED — unfixably, since correcting a value changes
 *   its hash.
 */
export function toDoc(e) {
  return {
    _id: e.seq,
    seq: e.seq,
    event_id: e.event_id,
    type: e.type,
    subject_ref: e.subject_ref ?? null,
    device_ref: e.device_ref ?? null,
    session_ref: e.session_ref ?? null,
    location_ref: e.location_ref ?? null,
    payload: e.payload ?? {},
    captured_at: e.captured_at ?? null,
    received_at: e.received_at,
    captured_at_d: e.captured_at ? new Date(e.captured_at) : null,
    received_at_d: new Date(e.received_at),
    device_time: e.device_time ?? null,
    uptime_ms: e.uptime_ms ?? null,
    canon_v: e.canon_v,
    prev_hash: e.prev_hash,
    hash: e.hash,
    signature: e.signature,
  };
}

/**
 * A stored document → an event.
 *
 * `?? null` on every optional field, deliberately. A MISSING BSON key reads as
 * `undefined`, and `Number(undefined)` is `NaN` — which envelopeOf's `?? undefined`
 * does not catch and canonical.js then refuses, taking /chain/verify and
 * /chain/export down with a 500 rather than reporting the one bad event.
 */
export function docToEvent(d) {
  return {
    seq: Number(d.seq),
    event_id: d.event_id,
    type: d.type,
    subject_ref: d.subject_ref ?? null,
    device_ref: d.device_ref ?? null,
    session_ref: d.session_ref ?? null,
    location_ref: d.location_ref ?? null,
    payload: d.payload ?? {},
    captured_at: d.captured_at ?? null,
    received_at: d.received_at ?? null,
    device_time: d.device_time ?? null,
    uptime_ms: d.uptime_ms ?? null,
    canon_v: Number(d.canon_v),
    prev_hash: d.prev_hash,
    hash: d.hash,
    signature: d.signature,
  };
}

/** Is this a type the chain is allowed to carry? BR-EVD-17. */
export const isKnownType = (type) => EVENT_TYPES.includes(type);

export async function chainHead() {
  const head = (await col('chain_head').findOne({ _id: HEAD_ID }))
            ?? { seq: 0, hash: GENESIS_HASH, updated_at: null };
  return { seq: Number(head.seq), hash: head.hash, updated_at: head.updated_at ?? null };
}

export async function readRange(fromSeq = 1, limit = 1000) {
  // LIMIT cannot be a placeholder in a MySQL prepared statement, so it is
  // coerced to a bounded integer and interpolated. Both values are forced
  // through Number and clamped first — nothing user-supplied reaches the SQL
  // as text.
  const from = Math.max(1, Math.floor(Number(fromSeq) || 1));
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 1000)), 50000);

  // Sorting on seq is an index scan for free: _id IS seq.
  const docs = await col('events')
    .find({ seq: { $gte: from } })
    .sort({ seq: 1 })
    .limit(take)
    .toArray();
  return docs.map(docToEvent);
}

/**
 * Walk the chain and report the FIRST place it breaks.
 *
 * Four things can be wrong and they are reported separately, because they
 * mean different things: a gap means a record was removed, a bad link means
 * one was altered, a bad hash means its content was altered, and a bad
 * signature means it was never ours.
 */
/**
 * The verification itself, over events already in hand and sorted by seq.
 *
 * Separated from the read so it can be tested without a database and reused by
 * any store. Nothing here touches SQL.
 */
export function verifyEvents(events, fromSeq = 1) {
  if (events.length === 0) return { ok: true, checked: 0, from: fromSeq, to: fromSeq - 1 };

  let expectedSeq = events[0].seq;
  let expectedPrev = expectedSeq === 1 ? GENESIS_HASH : null;
  let lastSeq = null;

  for (const e of events) {
    // ── DUPLICATE_SEQ ────────────────────────────────────────────────────
    // Under MySQL this could not happen: PRIMARY KEY (seq) made it
    // impossible, which is why there was no branch for it. Any store without
    // that guarantee can produce two events at one position — a FORK, where
    // both halves verify perfectly against themselves.
    //
    // It must be checked BEFORE the gap test, because a duplicate otherwise
    // trips that branch and is reported as "a record is missing". Accusing
    // yourself of deleting a record when what actually happened was a fork
    // sends the investigation in exactly the wrong direction.
    if (lastSeq !== null && e.seq === lastSeq) {
      return fail(e, 'DUPLICATE_SEQ',
        `two events occupy seq ${e.seq} — the chain has forked, no record is missing`);
    }
    lastSeq = e.seq;

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

export async function verifyChain({ fromSeq = 1, limit = 100000 } = {}) {
  return verifyEvents(await readRange(fromSeq, limit), fromSeq);
}

const fail = (e, reason, detail) => ({
  ok: false,
  reason,
  detail,
  at_seq: e.seq,
  event_id: e.event_id,
});
