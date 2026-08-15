/**
 * D2 · The MongoDB chain appender — prototype.
 *
 * Not yet wired into the application. This exists so the concurrency question
 * is settled before 88 call sites move (docs/mongodb-migration-plan.md §K4).
 *
 * THE PROBLEM
 *
 * `apps/api/src/lib/chain.js:113` gets gaplessness from one line:
 *
 *     SELECT seq, hash FROM chain_head WHERE id = 1 FOR UPDATE
 *
 * InnoDB queues concurrent appenders on that row lock. `seq` increments by
 * exactly one and `prev_hash` is always the hash of the event before, because
 * only one appender is ever inside the critical section.
 *
 * MongoDB has no `FOR UPDATE`. `schema.sql:231-235` already rejected
 * AUTO_INCREMENT because a rolled-back transaction burns a value and leaves a
 * gap that `verifyChain()` reports as a deleted record — and MongoDB's natural
 * `findOneAndUpdate({$inc:{seq:1}})` has exactly that flaw, plus a worse one:
 * it cannot carry `prev_hash`, because the new hash is not known until after
 * signing. Two appenders then sign different events with the same `prev_hash`
 * and the chain forks, with both halves verifying against themselves.
 *
 * THE ANSWER — compare-and-swap inside a transaction
 *
 * The head read is treated as a CLAIM, not a fact. It is only true if the
 * conditional update in step 4 still matches on the seq we read. Losing that
 * race aborts the whole transaction — nothing is inserted, no seq is consumed
 * — and we retry from a fresh read.
 *
 * Two independent defences, on purpose:
 *
 *   1. The CAS is correct even if the isolation level is not what we believe,
 *      and stays correct across two API processes (a rolling restart), where
 *      an in-process mutex would not.
 *   2. `_id = seq` means two events cannot occupy one position even if the
 *      CAS itself has a bug. The second insert fails on the primary key.
 */

import { createHash } from 'node:crypto';
import { MongoClient, MongoServerError } from 'mongodb';
import { canonicalBytes, CANON_VERSION } from '../src/lib/canonical.js';
import { sign } from '../src/lib/signing.js';
import { envelopeOf } from '../src/lib/chain.js';

export const GENESIS_HASH =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';

export const HEAD_ID = 'HEAD';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const iso = (d) => new Date(d).toISOString();

/** Proven necessary in D1 — see plan §L. None of these is a preference. */
export const REQUIRED_CLIENT_OPTIONS = {
  promoteBuffers: true,
  promoteLongs: true,
  ignoreUndefined: false,
  readPreference: 'primary',
  readConcern: { level: 'majority' },
  writeConcern: { w: 'majority', j: true },
};

const TXN_OPTIONS = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority', j: true },
  readPreference: 'primary',
};

/** We lost the race for this position. Not an error condition — retry. */
export class ChainRaceError extends Error {
  constructor(seq) {
    super(`chain head moved past ${seq}`);
    this.name = 'ChainRaceError';
  }
}

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/;

/**
 * Refuse what BSON cannot hold faithfully, BEFORE it is signed. D1 proved a
 * lone surrogate is silently replaced with U+FFFD. A payload that cannot be
 * read back byte-identically must become a quarantine (BR-EVD-20), never a
 * silently rewritten event.
 */
export function assertBsonSafe(value, path = '$') {
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) {
      throw new Error(`unpaired surrogate at ${path} — BSON would replace it with U+FFFD`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertBsonSafe(v, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      if (LONE_SURROGATE.test(k)) throw new Error(`unpaired surrogate in key at ${path}.${k}`);
      if (k.includes('.') || k.startsWith('$')) {
        throw new Error(`key ${JSON.stringify(k)} at ${path} uses '.' or a leading '$'`);
      }
      assertBsonSafe(value[k], `${path}.${k}`);
    }
  }
}

/** Timestamps are stored as the EXACT ISO strings that were signed (plan §D). */
export function toDoc(e) {
  return {
    _id: e.seq,
    seq: e.seq,
    event_id: e.event_id,
    type: e.type,
    subject_ref: e.subject_ref,
    device_ref: e.device_ref,
    session_ref: e.session_ref,
    location_ref: e.location_ref,
    payload: e.payload ?? {},
    captured_at: e.captured_at,
    received_at: e.received_at,
    captured_at_d: e.captured_at ? new Date(e.captured_at) : null,
    received_at_d: new Date(e.received_at),
    device_time: e.device_time,
    uptime_ms: e.uptime_ms,
    canon_v: e.canon_v,
    prev_hash: e.prev_hash,
    hash: e.hash,
    signature: e.signature,
  };
}

/** `?? null` everywhere: a missing key is undefined, and Number(undefined) is NaN. */
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

export async function ensureSchema(db) {
  await db.collection('events').createIndex({ event_id: 1 }, { unique: true, name: 'uq_events_event_id' });
  await db.collection('events').createIndex({ hash: 1 }, { unique: true, name: 'uq_events_hash' });
  await db.collection('events').createIndex({ subject_ref: 1, seq: 1 }, { name: 'idx_events_subject' });
  await db.collection('chain_head').updateOne(
    { _id: HEAD_ID },
    { $setOnInsert: { seq: 0, hash: GENESIS_HASH, updated_at: new Date() } },
    { upsert: true },
  );
}

const isTransient = (err) =>
  err?.hasErrorLabel?.('TransientTransactionError') ||
  err?.hasErrorLabel?.('UnknownTransactionCommitResult') ||
  err?.codeName === 'WriteConflict' ||
  err?.code === 112;

const isDuplicateKey = (err) => err instanceof MongoServerError && err.code === 11000;

/**
 * An in-process queue in front of the appender — a THROUGHPUT optimisation,
 * never a correctness mechanism.
 *
 * Measured (tools/d2-throughput.mjs): with 50 appends in flight, the
 * compare-and-swap loses often enough that each transaction body runs 8.73
 * times on average, and every one of those runs re-signs — the signature
 * covers prev_hash, which changes on each retry, so the work cannot be
 * hoisted out of the loop. Throughput collapses from 104/s to 34/s while
 * MySQL's row lock holds a flat ~210/s, because InnoDB QUEUES contenders
 * where MongoDB ABORTS them.
 *
 * Serialising locally converts that contention into a queue, which is what
 * the row lock was doing all along.
 *
 * ⚠ This is a fast path, not a guarantee. It is confined to one Node process,
 *   so it does nothing during a rolling restart or if the API is ever run with
 *   two workers. The compare-and-swap at step 4 remains the thing that makes
 *   the chain correct, and every test in test/chain-concurrency.mjs must pass
 *   with this queue DISABLED.
 */
let appendQueue = Promise.resolve();

export function serialise(fn) {
  const run = appendQueue.then(fn, fn);
  // Keep the chain alive after a rejection, and do not leak the rejection
  // into the next caller.
  appendQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Append one event. Gapless, or it throws.
 *
 * @param {import('mongodb').MongoClient} client
 * @param {object} input
 * @param {{maxAttempts?: number, stats?: object, injectFailure?: Function, queue?: boolean}} opts
 *   injectFailure is for the negative control only — it is how a crash between
 *   signing and insert is simulated. Production has no such hook.
 *   queue: false disables the in-process fast path, which is how the
 *   correctness tests prove the CAS carries the guarantee on its own.
 */
export async function appendEvent(client, input, opts = {}) {
  if (opts.queue === false) return appendEventInner(client, input, opts);
  return serialise(() => appendEventInner(client, input, opts));
}

async function appendEventInner(client, input, opts = {}) {
  const { maxAttempts = 25, stats = null, injectFailure = null } = opts;
  const db = client.db();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const session = client.startSession();
    try {
      let result = null;

      await session.withTransaction(async () => {
        // Counted INSIDE the callback on purpose. withTransaction retries
        // TransientTransactionError/WriteConflict itself, so those retries are
        // invisible to the outer loop — an outer-loop counter reports zero
        // contention under load that is in fact heavily contended.
        if (stats !== null) stats.bodyRuns = (stats.bodyRuns ?? 0) + 1;

        const events = db.collection('events');
        const heads = db.collection('chain_head');

        // 1 ── Idempotency first. BR-EVD-19: a phone that lost signal mid-upload
        //      must be free to send everything again, always.
        const existing = await events.findOne({ event_id: input.event_id }, { session });
        if (existing !== null) {
          result = { status: 'duplicate', event: docToEvent(existing) };
          return;
        }

        // 2 ── Read the head. A CLAIM, not a fact — see step 4.
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

        // 3 ── Refuse anything BSON cannot hold, before it is signed.
        assertBsonSafe(event.payload, '$.payload');

        const bytes = canonicalBytes(envelopeOf(event));
        event.hash = sha256(bytes);
        event.signature = sign(bytes);

        if (injectFailure !== null) await injectFailure(event, 'after-sign');

        // 4 ── THE LOCK, such as it is. Conditional on the head not having
        //      moved since step 2. matchedCount 0 means somebody else got this
        //      position: abort, consume nothing, retry from a fresh read.
        const swap = await heads.updateOne(
          { _id: HEAD_ID, seq: prevSeq },
          { $set: { seq: event.seq, hash: event.hash, updated_at: new Date() } },
          { session, upsert: false },
        );
        if (swap.matchedCount !== 1) throw new ChainRaceError(prevSeq);

        // 5 ── _id IS seq. Even a CAS bug cannot put two events at one position.
        await events.insertOne(toDoc(event), { session });

        if (injectFailure !== null) await injectFailure(event, 'after-insert');

        result = { status: 'appended', event };
      }, TXN_OPTIONS);

      if (stats !== null) stats.attempts = (stats.attempts ?? 0) + attempt;
      return result;
    } catch (err) {
      // A concurrent appender beat us to this position, or the server aborted
      // us for write conflict. Neither has consumed a seq — the whole
      // transaction rolled back — so retrying is safe and is the correct
      // behaviour rather than a workaround.
      if (err instanceof ChainRaceError || isTransient(err) || isDuplicateKey(err)) {
        if (stats !== null) stats.retries = (stats.retries ?? 0) + 1;

        // A duplicate event_id that was NOT visible at step 1 means a
        // concurrent delivery of the same event won. That is a duplicate, not
        // an error: BR-EVD-19 again.
        if (isDuplicateKey(err) && String(err.message).includes('uq_events_event_id')) {
          const existing = await db.collection('events').findOne({ event_id: input.event_id });
          if (existing !== null) return { status: 'duplicate', event: docToEvent(existing) };
        }

        if (attempt === maxAttempts) {
          throw new Error(`append failed after ${maxAttempts} attempts: ${err.message}`);
        }
        // Jittered backoff. Without jitter, N appenders retry in lockstep and
        // collide again on every round.
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

/**
 * ⚠ THE NEGATIVE CONTROL — a deliberately WRONG appender.
 *
 * This is the implementation the plan warns against: the idiomatic MongoDB
 * counter. It is here so the test can prove it FAILS. A concurrency test that
 * cannot distinguish this from the real one is not testing anything.
 *
 * Two defects, both from §C of the plan:
 *   1. The $inc commits independently of the insert, so any failure between
 *      them burns a seq permanently — AUTO_INCREMENT, reintroduced.
 *   2. It cannot carry prev_hash. The head's hash is written in a second
 *      operation, so concurrent appenders read the same stale hash and the
 *      chain forks.
 *
 * ⚠ Takes a DB, not a client. It used to take a client and call `client.db()`,
 *   which resolves to the connection string's DEFAULT database — not the one
 *   the application is configured with. The control was therefore writing to an
 *   empty database and "failing" only because it found zero events, which is a
 *   false pass: it would have reported failure against a perfectly correct
 *   appender too.
 */
export async function appendEventNAIVE(db, input, opts = {}) {
  const { injectFailure = null } = opts;
  const events = db.collection('events');
  const heads = db.collection('chain_head');

  const existing = await events.findOne({ event_id: input.event_id });
  if (existing !== null) return { status: 'duplicate', event: docToEvent(existing) };

  // Atomic for the counter, and useless for everything else.
  const before = await heads.findOneAndUpdate(
    { _id: HEAD_ID },
    { $inc: { seq: 1 } },
    { returnDocument: 'before' },
  );
  const prevSeq = Number(before.seq);

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
    prev_hash: before.hash,          // ← STALE under concurrency. The fork.
    canon_v: CANON_VERSION,
  };

  const bytes = canonicalBytes(envelopeOf(event));
  event.hash = sha256(bytes);
  event.signature = sign(bytes);

  if (injectFailure !== null) await injectFailure(event, 'after-sign');

  await events.insertOne(toDoc(event));
  await heads.updateOne({ _id: HEAD_ID }, { $set: { hash: event.hash } });

  return { status: 'appended', event };
}

export async function connect(url) {
  const client = new MongoClient(url, REQUIRED_CLIENT_OPTIONS);
  await client.connect();
  return client;
}
