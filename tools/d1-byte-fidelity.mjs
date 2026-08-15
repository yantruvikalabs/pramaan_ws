/**
 * D1 · Byte-fidelity spike — docs/mongodb-migration-plan.md §K4.
 *
 * The question this answers, and the only one: can MongoDB hold an event such
 * that canonicalBytes(envelopeOf(e)) comes back BYTE-IDENTICAL?
 *
 * Not "does it verify" — a systematic error produces a chain that verifies
 * perfectly against itself while disagreeing with the head a contractor already
 * holds, and that is indistinguishable from the server having rewritten history.
 * Byte equality is the only gate that catches it.
 *
 * Nothing here writes to MySQL. The Mongo side uses a scratch database that is
 * dropped on every run.
 *
 *   node --env-file=../../.env tools/d1-byte-fidelity.mjs
 */

import { createHash } from 'node:crypto';
import { MongoClient, Long, Binary, Double, Int32 } from 'mongodb';
import { query, closePool } from '../src/db.js';
import { envelopeOf, rowToEvent } from '../src/lib/chain.js';
import { canonicalBytes, canonicalString } from '../src/lib/canonical.js';
import { verify } from '../src/lib/signing.js';

const MONGO_URL = process.env.D1_MONGO_URL ?? 'mongodb://127.0.0.1:27018/?replicaSet=rs0';
const SCRATCH_DB = 'pramaan_d1_scratch';

const sha256 = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
  return ok;
}

function section(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

// ═════════════════════════════════════════════════════════════════════════
// PART 1 · Prove the ASSUMED rows in the plan's §0 by RUNNING them.
// Every one of these was written down as an assumption. An assumption that
// silently corrupts the chain is exactly the class of bug this spike exists
// to catch, so none of them is taken on trust.
// ═════════════════════════════════════════════════════════════════════════

async function proveDriverBehaviour(db) {
  section('PART 1 · Driver behaviour — assumptions proven by execution');

  const c = db.collection('probe');
  await c.deleteMany({});

  // ── Long.toJSON(). The plan (§0, risk 1) assumed this returns a STRING and
  //    that "seq":"1200" would break verify.html. Measured, it is worse: an
  //    OBJECT. Same conclusion, bigger blast radius — assert the hazard so
  //    this stays true if a driver upgrade changes it.
  const asJson = JSON.stringify({ seq: Long.fromNumber(1200) });
  check(
    'HAZARD: a Long does not JSON.stringify as a number — keep Longs out of the envelope',
    asJson !== '{"seq":1200}',
    `JSON.stringify({seq: Long.fromNumber(1200)}) === ${asJson}`,
  );

  // ── canonical.js refuses non-numbers. A Long reaching it emits an object.
  let longCanon = null;
  try { longCanon = canonicalString({ seq: Long.fromNumber(5) }); } catch (e) { longCanon = `THREW: ${e.message}`; }
  check(
    'a Long reaching canonical.js does NOT silently canonicalise as a number',
    longCanon !== '{"seq":5}',
    `canonicalString({seq: Long}) === ${longCanon}  ← if this is an object form, promoteLongs must stay on`,
  );

  // ── promoteLongs default. If a stored int64 comes back as a Long object,
  //    canon() hits its object branch and emits {"high":..,"low":..}.
  await c.insertOne({ _id: 'longs', big: Long.fromNumber(9007199254740991), small: Long.fromNumber(42) });
  const gotLongs = await c.findOne({ _id: 'longs' });
  check(
    'driver default promotes int64 back to a JS number (promoteLongs)',
    typeof gotLongs.small === 'number' && typeof gotLongs.big === 'number',
    `typeof small === ${typeof gotLongs.small}, typeof big === ${typeof gotLongs.big}`,
  );

  // ── promoteBuffers default. embed.js:199 expects a Node Buffer; a BSON
  //    Binary exposes length as a METHOD, so new Array(NaN) throws.
  const emb = Buffer.alloc(512 * 8);
  emb.writeDoubleLE(0.5, 0);
  await c.insertOne({ _id: 'bin', embedding: emb });
  const gotBin = await c.findOne({ _id: 'bin' });
  check(
    'HAZARD: promoteBuffers is OFF by default — .length is a method, not a number',
    !Buffer.isBuffer(gotBin.embedding) && typeof gotBin.embedding.length === 'function',
    `embedding is ${gotBin.embedding?.constructor?.name}, typeof .length === ${typeof gotBin.embedding.length}. ` +
    'embed.js:199 would do new Array(NaN) — promoteBuffers:true is REQUIRED',
  );

  // ── Key ordering. canonical.js sorts, so this should not matter — proving
  //    it rather than believing it, because the whole envelope depends on it.
  await c.insertOne({ _id: 'order', z: 1, a: 2, m: 3 });
  const gotOrder = await c.findOne({ _id: 'order' });
  const { _id, ...orderPayload } = gotOrder;
  check(
    'key order is irrelevant — canonical.js sorts',
    canonicalString(orderPayload) === '{"a":2,"m":3,"z":1}',
    canonicalString(orderPayload),
  );

  // ── null vs undefined vs absent. envelopeOf uses `?? undefined` and
  //    canon() OMITS null and undefined alike, so all three must agree.
  await c.insertOne({ _id: 'nulls', explicitNull: null, present: 1 });
  const gotNulls = await c.findOne({ _id: 'nulls' });
  check(
    'an explicit BSON null canonicalises identically to an absent key',
    canonicalString({ present: 1, explicitNull: gotNulls.explicitNull }) === '{"present":1}',
    canonicalString({ present: 1, explicitNull: gotNulls.explicitNull }),
  );

  // ── The H6 trap: a MISSING key reads as undefined, and
  //    Number(undefined) === NaN, which canon() does NOT omit — it throws.
  const missing = gotNulls.notThere;
  let nanBehaviour;
  try { nanBehaviour = canonicalString({ uptime_ms: Number(missing) ?? undefined }); }
  catch (e) { nanBehaviour = `THREW: ${e.message.slice(0, 60)}`; }
  check(
    'Number(missing field) produces NaN that canonical.js REFUSES (loud, not silent)',
    String(nanBehaviour).startsWith('THREW'),
    `${nanBehaviour} — read paths must use ?? null, never Number() on a possibly-absent field`,
  );

  // ── Lone surrogate. MySQL JSON round-trips the escape; BSON may replace it
  //    with U+FFFD, which would alter exactly one event, permanently.
  const lone = 'ok\ud800tail';
  await c.insertOne({ _id: 'surrogate', s: lone });
  const gotSurrogate = await c.findOne({ _id: 'surrogate' });
  check(
    'HAZARD CONFIRMED: BSON silently replaces a lone surrogate with U+FFFD',
    gotSurrogate.s !== lone,
    `sent ${JSON.stringify(lone)}, got ${JSON.stringify(gotSurrogate.s)}. ` +
    'This is the STATUS.md .000 bug class: rare, per-event, permanent. Must be refused at ingest.',
  );

  // ── Doubles. canonical.js REFUSES non-integers outright, so coordinates
  //    must never enter the envelope. Confirming a Double is not an integer
  //    in disguise.
  await c.insertOne({ _id: 'dbl', lat: new Double(12.971599) });
  const gotDbl = await c.findOne({ _id: 'dbl' });
  check(
    'a Double round-trips as a JS number (for location_fixes, never the envelope)',
    typeof gotDbl.lat === 'number' && Math.abs(gotDbl.lat - 12.971599) < 1e-12,
    `typeof ${typeof gotDbl.lat}, value ${gotDbl.lat}`,
  );

  // ── Booleans, for is_mock (audit H2).
  await c.insertOne({ _id: 'bool', is_mock: true });
  const gotBool = await c.findOne({ _id: 'bool' });
  check(
    'a BSON boolean is NOT === 1 (refs.js:104 must change)',
    gotBool.is_mock === true && gotBool.is_mock !== 1,
    'refs.js reads `r.is_mock === 1`; against a real boolean that is false for every spoofed fix',
  );

  // ── Dates. The whole J1 finding. A BSON Date is an object, not a string.
  const when = new Date('2026-08-03T06:28:15.000Z');
  await c.insertOne({ _id: 'date', at: when });
  const gotDate = await c.findOne({ _id: 'date' });
  // J1. The drift is EXACTLY the runner's UTC offset — which is why this bug
  // is dormant on a UTC CI box and live in India. Asserting the relationship
  // rather than "it is wrong" keeps the check honest in every timezone; under
  // TZ=UTC the offset is 0 and the interpolation is accidentally correct.
  const interpolated = new Date(`${gotDate.at}Z`).getTime();
  const localOffsetMs = -new Date().getTimezoneOffset() * 60_000;
  check(
    'J1: interpolating a BSON Date into `${d}Z` drifts by exactly the local UTC offset',
    interpolated - when.getTime() === localOffsetMs,
    `correct ${when.getTime()}, interpolated ${interpolated}, ` +
    `drift ${(interpolated - when.getTime()) / 3_600_000}h vs local offset ${localOffsetMs / 3_600_000}h`,
  );
  if (localOffsetMs === 0) {
    console.log('      ⚠ TZ has zero offset — J1 is DORMANT here and would ship green.');
    console.log('        Re-run under TZ=Asia/Kolkata to see it. This is the whole point of J1.');
  } else {
    console.log(`      → a 10-minute OTP would live ${(10 + localOffsetMs / 60_000)} minutes ` +
                '(auth.js:187, sessions.js:106,123)');
  }
  check(
    'a BSON Date preserves exact millisecond precision (no .000 trimming)',
    gotDate.at.toISOString() === when.toISOString(),
    `${gotDate.at.toISOString()} vs ${when.toISOString()}`,
  );

  await c.drop();
}

// ═════════════════════════════════════════════════════════════════════════
// PART 1b · The mitigations, proven to work.
// Each answers exactly one hazard confirmed above.
// ═════════════════════════════════════════════════════════════════════════

/**
 * The client options this migration REQUIRES. Not preferences — each one
 * answers a hazard measured in Part 1, and dropping any of them reintroduces
 * a silent corruption.
 */
export const REQUIRED_CLIENT_OPTIONS = {
  promoteBuffers: true,                     // HAZARD 2: Binary.length is a method
  promoteLongs: true,                       // default, but load-bearing: a Long in the envelope canonicalises as an object
  ignoreUndefined: false,                   // an undefined must be stored as null, never dropped silently
  readPreference: 'primary',                // a stale head read forks the chain (audit H9)
  readConcern: { level: 'majority' },
  writeConcern: { w: 'majority', j: true }, // audit C3: an acked-then-rolled-back event is a permanent gap
};

/** A lone surrogate — half a character. BSON replaces it with U+FFFD. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/;

/**
 * Refuse anything BSON cannot hold faithfully, BEFORE it is signed.
 *
 * A payload that cannot be read back byte-identically must become a quarantine
 * (BR-EVD-20), never a silently rewritten event. Rewriting is the one thing
 * this product cannot do.
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

async function proveMitigations() {
  section('PART 1b · Mitigations — each answers one hazard above');

  const client = new MongoClient(MONGO_URL, REQUIRED_CLIENT_OPTIONS);
  await client.connect();
  const db = client.db(SCRATCH_DB);
  const c = db.collection('mitigation_probe');
  await c.deleteMany({});

  try {
    // HAZARD 2 → promoteBuffers: true
    const emb = Buffer.alloc(512 * 8);
    emb.writeDoubleLE(0.5, 0);
    emb.writeDoubleLE(-0.25, 8);
    await c.insertOne({ _id: 'bin', embedding: emb, dimensions: 512 });
    const got = await c.findOne({ _id: 'bin' });
    check(
      'promoteBuffers:true → a real Node Buffer, so embed.js:199 works unchanged',
      Buffer.isBuffer(got.embedding) && got.embedding.length === 512 * 8,
      `constructor ${got.embedding?.constructor?.name}, length ${got.embedding?.length}`,
    );
    check(
      'the embedding decodes to the exact floats written (embed.js parity)',
      got.embedding.readDoubleLE(0) === 0.5 && got.embedding.readDoubleLE(8) === -0.25,
      `[0]=${got.embedding.readDoubleLE(0)}, [1]=${got.embedding.readDoubleLE(8)}`,
    );
    check(
      'the assertion embed.js does NOT have today: byte length matches dimensions',
      got.embedding.length / 8 === got.dimensions,
      `${got.embedding.length} / 8 !== ${got.dimensions}`,
    );

    // HAZARD 3 → refuse lone surrogates at the boundary, before signing
    let caught = null;
    try { assertBsonSafe({ note: 'ok\ud800tail' }); } catch (e) { caught = e.message; }
    check(
      'assertBsonSafe refuses a lone surrogate before it can be signed',
      caught !== null && caught.includes('unpaired surrogate'),
      caught ?? 'nothing thrown — a corrupting payload would have been signed',
    );
    check(
      'assertBsonSafe accepts a legitimate surrogate PAIR (emoji must still work)',
      (() => { try { assertBsonSafe({ tag: '👷🏽‍♀️ सुनीता' }); return true; } catch { return false; } })(),
      'a false positive here would reject real Hindi/emoji names',
    );
    for (const bad of [{ 'a.b': 1 }, { $set: 1 }]) {
      const key = Object.keys(bad)[0];
      let threw = false;
      try { assertBsonSafe(bad); } catch { threw = true; }
      check(`assertBsonSafe refuses the key ${JSON.stringify(key)}`, threw);
    }

    // HAZARD 1 → plain JS numbers, never Long, in anything that gets signed
    await c.insertOne({ _id: 'nums', seq: 608, uptime_ms: 123456, canon_v: 1 });
    const nums = await c.findOne({ _id: 'nums' });
    check(
      'plain JS integers come back as numbers, never Long',
      typeof nums.seq === 'number' && typeof nums.uptime_ms === 'number' && typeof nums.canon_v === 'number',
      `seq ${typeof nums.seq}, uptime_ms ${typeof nums.uptime_ms}, canon_v ${typeof nums.canon_v}`,
    );
    check(
      'and they canonicalise as bare integers',
      canonicalString({ seq: nums.seq, canon_v: nums.canon_v }) === '{"canon_v":1,"seq":608}',
      canonicalString({ seq: nums.seq, canon_v: nums.canon_v }),
    );

    // ignoreUndefined:false — an undefined must become null, not vanish.
    // If it vanished, a read would give undefined, Number(undefined) is NaN,
    // and canonical.js throws (proven in Part 1). Fail loud, not silent.
    await c.insertOne({ _id: 'undef', a: 1, b: undefined });
    const undef = await c.findOne({ _id: 'undef' });
    check(
      'ignoreUndefined:false stores undefined as an explicit null',
      'b' in undef && undef.b === null,
      `'b' in doc === ${'b' in undef}, value ${JSON.stringify(undef.b)}`,
    );

    // The transaction machinery D2 depends on. Prove it exists NOW, cheaply.
    const session = client.startSession();
    let txnOk = false;
    try {
      await session.withTransaction(async () => {
        await c.insertOne({ _id: 'txn', v: 1 }, { session });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true } });
      txnOk = (await c.findOne({ _id: 'txn' }))?.v === 1;
    } finally {
      await session.endSession();
    }
    check('multi-document transactions work on this deployment (D2 depends on it)', txnOk);
  } finally {
    await c.drop().catch(() => {});
    await client.close();
  }
}

// ═════════════════════════════════════════════════════════════════════════
// PART 2 · The real chain, round-tripped.
// ═════════════════════════════════════════════════════════════════════════

/**
 * MySQL row → Mongo document.
 *
 * Timestamps are stored as the EXACT ISO STRINGS THAT WERE SIGNED, with a
 * parallel BSON Date for querying. Plan §D: this deletes the conversion rather
 * than porting it, and with it the whole class of bug that produced the
 * trailing-.000 incident (chain.js:60-78) and every timezone-shift risk.
 *
 * _id IS seq — two events cannot occupy one position even if the head
 * compare-and-swap has a bug.
 */
function toDoc(e) {
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
    captured_at: e.captured_at,                                    // signed string
    received_at: e.received_at,                                    // signed string
    captured_at_d: e.captured_at ? new Date(e.captured_at) : null, // query only
    received_at_d: new Date(e.received_at),                        // query only
    device_time: e.device_time,
    uptime_ms: e.uptime_ms,
    canon_v: e.canon_v,
    prev_hash: e.prev_hash,
    hash: e.hash,
    signature: e.signature,
  };
}

/**
 * Mongo document → the same shape rowToEvent() produces.
 * `?? null` everywhere: a missing BSON key is undefined, and Number(undefined)
 * is NaN, which canonical.js refuses (proven in Part 1).
 */
function docToEvent(d) {
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

async function roundTripChain(db) {
  section('PART 2 · The real chain, MySQL → BSON → back');

  const rows = await query('SELECT * FROM events ORDER BY seq ASC');
  console.log(`  read ${rows.length} events from MySQL\n`);
  if (rows.length === 0) {
    check('there are events to test', false, 'events table is empty');
    return;
  }

  const events = rows.map(rowToEvent);
  const col = db.collection('events');
  await col.deleteMany({});
  await col.insertMany(events.map(toDoc), { ordered: true });

  const back = await col.find({}).sort({ seq: 1 }).toArray();
  check('every event came back', back.length === events.length, `${back.length} of ${events.length}`);

  let byteMismatch = 0, hashMismatch = 0, sigFail = 0, firstBad = null;

  for (let i = 0; i < events.length; i += 1) {
    const fromMysql = canonicalBytes(envelopeOf(events[i]));
    const fromMongo = canonicalBytes(envelopeOf(docToEvent(back[i])));

    if (!fromMysql.equals(fromMongo)) {
      byteMismatch += 1;
      if (firstBad === null) {
        firstBad = {
          seq: events[i].seq,
          mysql: fromMysql.toString('utf8'),
          mongo: fromMongo.toString('utf8'),
        };
      }
    }
    if (sha256(fromMongo) !== events[i].hash) hashMismatch += 1;
    if (!verify(fromMongo, back[i].signature)) sigFail += 1;
  }

  check('canonical bytes are IDENTICAL for all events', byteMismatch === 0, `${byteMismatch} differ`);
  check('recomputed hash matches the stored hash for all events', hashMismatch === 0, `${hashMismatch} differ`);
  check('the original signature still verifies for all events', sigFail === 0, `${sigFail} failed`);

  if (firstBad !== null) {
    console.log('\n  first divergence, seq', firstBad.seq);
    console.log('    mysql:', firstBad.mysql.slice(0, 300));
    console.log('    mongo:', firstBad.mongo.slice(0, 300));
    for (let i = 0; i < Math.max(firstBad.mysql.length, firstBad.mongo.length); i += 1) {
      if (firstBad.mysql[i] !== firstBad.mongo[i]) {
        console.log(`    first differing char at ${i}: ` +
          `${JSON.stringify(firstBad.mysql.slice(i, i + 40))} vs ${JSON.stringify(firstBad.mongo.slice(i, i + 40))}`);
        break;
      }
    }
  }

  // ── Structure must MATCH the source, not be perfect ─────────────────────
  //
  // A migration's job is to reproduce what is there, defects included. This
  // originally asserted "gapless 1..N" and failed — correctly detecting a gap
  // at seq 300 that `test/gate2.mjs:201` creates ON PURPOSE, to prove the
  // verifier notices a deleted record.
  //
  // Asserting an ideal would mean D1 could only run against a pristine chain,
  // and would report a faithful copy of an imperfect chain as a migration
  // failure. What must hold is that Mongo's structure is IDENTICAL to MySQL's.
  const structureOf = (list) => ({
    seqs: list.map((e) => Number(e.seq)),
    brokenLinks: list
      .filter((e, i) => i > 0 && e.prev_hash !== list[i - 1].hash)
      .map((e) => Number(e.seq)),
  });

  const src = structureOf(events);
  const dst = structureOf(back.map(docToEvent));

  check(
    'the seq sequence is reproduced exactly, gaps and all',
    JSON.stringify(src.seqs) === JSON.stringify(dst.seqs),
    `mysql has ${src.seqs.length} seqs, mongo ${dst.seqs.length}`,
  );
  check(
    'the prev_hash link structure is reproduced exactly',
    JSON.stringify(src.brokenLinks) === JSON.stringify(dst.brokenLinks),
    `mysql breaks at [${src.brokenLinks}], mongo at [${dst.brokenLinks}]`,
  );

  // Report the source's own health separately — informational, not a gate.
  const missing = [];
  for (let i = 1; i < src.seqs.length; i += 1) {
    if (src.seqs[i] !== src.seqs[i - 1] + 1) missing.push(src.seqs[i - 1] + 1);
  }
  if (missing.length > 0 || src.brokenLinks.length > 0) {
    console.log(`\n  ℹ the SOURCE chain is not pristine: missing seq [${missing}], ` +
                `broken links at [${src.brokenLinks}]`);
    console.log('    Expected on a dev database — test/gate2.mjs:201 deletes seq 300 on purpose');
    console.log('    to prove gap detection. D1 asks whether the copy is faithful, not');
    console.log('    whether the original is sound.');
  }

  const head = await query('SELECT seq, hash FROM chain_head WHERE id = 1');
  check(
    'the Mongo copy reproduces the MySQL chain head',
    Number(head[0].seq) === Number(back[back.length - 1].seq) &&
      head[0].hash === back[back.length - 1].hash,
    `mysql ${head[0].seq}/${head[0].hash?.slice(0, 20)}… vs mongo ` +
    `${back[back.length - 1].seq}/${back[back.length - 1].hash?.slice(0, 20)}…`,
  );

  // ── NEGATIVE CONTROL ────────────────────────────────────────────────────
  // "608 events matched" is worthless if the comparison cannot fail. Corrupt
  // a copy four different ways and require every one to be caught. Each
  // mutation is a real migration failure mode, not an invented one.
  console.log('\n  negative control — each corruption MUST be detected:');

  const victim = events[Math.floor(events.length / 2)];

  // Two kinds of corruption, and they must be injected at different levels.
  //
  //   docLevel   — survives the whole document → event → bytes path. This is
  //                what a bad migration script produces.
  //   eventLevel — injected AFTER docToEvent, modelling a read path that
  //                forgot a coercion. docToEvent's own Number()/?? null are
  //                defences, so a doc-level probe here would be neutralised by
  //                them and prove nothing.
  //
  // A timestamp ending in .000Z is BUILT rather than searched for: none of the
  // 608 real events happens to land on an exact second, so a probe that relied
  // on finding one would silently pass without testing anything.
  const exactSecond = { ...victim, received_at: '2026-08-03T06:28:15.000Z' };

  const mutations = [
    ['docLevel', 'one character of payload changed',
      (d) => ({ ...d, payload: { ...d.payload, __probe: 'x' } }), victim],
    ['docLevel', 'timestamp shifted by the IST offset (audit H4)',
      (d) => ({ ...d, received_at: new Date(new Date(d.received_at).getTime() + 19_800_000).toISOString() }), victim],
    ['eventLevel', 'trailing .000 trimmed (the STATUS.md bug)',
      (e) => ({ ...e, received_at: e.received_at.replace('.000Z', 'Z') }), exactSecond],
    ['eventLevel', 'seq arrives as a Long (a read path missing its Number())',
      (e) => ({ ...e, seq: Long.fromNumber(e.seq) }), exactSecond],
    ['eventLevel', 'uptime_ms arrives as NaN (audit H6, missing key)',
      (e) => ({ ...e, uptime_ms: Number(undefined) }), exactSecond],
  ];

  for (const [level, name, mutate, base] of mutations) {
    const expected = canonicalBytes(envelopeOf(base));
    let detected = false;
    let how = '';
    try {
      const corruptedEvent = level === 'docLevel'
        ? docToEvent(mutate(toDoc(base)))
        : mutate(base);
      const corrupted = canonicalBytes(envelopeOf(corruptedEvent));
      detected = !expected.equals(corrupted);
      how = detected ? 'bytes differ' : 'NOT DETECTED — the comparison is blind to this';
    } catch (e) {
      detected = true;                       // canonical.js refusing it is also detection
      how = `refused by canonical.js: ${e.message.slice(0, 60)}`;
    }
    check(`  detected: ${name}`, detected, how);
    if (detected) console.log(`      (${how})`);
  }

  // And the control on the control: an UNMODIFIED event must NOT be flagged.
  // Without this, a comparison that reported everything as different would
  // score four out of four above.
  check(
    '  an unmodified event is NOT flagged (no false positives)',
    canonicalBytes(envelopeOf(victim)).equals(canonicalBytes(envelopeOf(docToEvent(toDoc(victim))))),
    'the comparison flags identical input — every detection above is meaningless',
  );
}

// ═════════════════════════════════════════════════════════════════════════
// PART 3 · The awkward payloads, which the 608 real events do not contain.
// ═════════════════════════════════════════════════════════════════════════

async function proveAwkwardPayloads(db) {
  section('PART 3 · Payload shapes the real chain does not happen to contain');

  const col = db.collection('payload_probe');
  await col.deleteMany({});

  const cases = [
    ['nested integers and arrays', { a: 1, b: [1, 2, 3], c: { d: 4, e: [{ f: 5 }] } }],
    ['empty object', {}],
    ['empty array', { list: [] }],
    ['unicode and emoji', { name: 'सुनीता देवी', tag: '👷🏽‍♀️' }],
    ['a very long string', { note: 'x'.repeat(10_000) }],
    ['deeply nested', { l1: { l2: { l3: { l4: { l5: { v: 1 } } } } } }],
    ['booleans and zero', { yes: true, no: false, zero: 0 }],
    ['large safe integer', { n: Number.MAX_SAFE_INTEGER }],
    ['negative integers', { n: -42, m: -0 }],
  ];

  for (const [name, payload] of cases) {
    const before = canonicalString(payload);
    let after;
    try {
      await col.insertOne({ _id: name, payload });
      const got = await col.findOne({ _id: name });
      after = canonicalString(got.payload);
    } catch (e) {
      after = `THREW: ${e.message.slice(0, 80)}`;
    }
    check(`payload survives: ${name}`, before === after, `before ${before.slice(0, 90)}\n      after  ${String(after).slice(0, 90)}`);
  }

  // Keys BSON tooling handles badly. These must be REFUSED at the boundary,
  // not stored — a payload that cannot be read back identically must become a
  // quarantine (BR-EVD-20), never a silently-rewritten event.
  for (const [name, payload] of [
    ['dotted key', { 'a.b': 1 }],
    ['dollar-prefixed key', { $set: 1 }],
  ]) {
    let stored = false, readBack = null;
    try {
      await col.insertOne({ _id: name, payload });
      stored = true;
      readBack = canonicalString((await col.findOne({ _id: name })).payload);
    } catch (e) {
      readBack = `REFUSED: ${e.message.slice(0, 60)}`;
    }
    console.log(`  · ${name}: ${stored ? 'accepted' : 'rejected'} by the driver → ${String(readBack).slice(0, 70)}`);
    if (stored && readBack === canonicalString(payload)) {
      console.log('      round-trips cleanly, but still reject at the zod boundary — aggregation and tooling differ');
    }
  }

  // An exact-second timestamp: the shape that caused the .000 incident.
  const exact = '2026-08-03T06:28:15.000Z';
  await col.insertOne({ _id: 'exact-second', received_at: exact });
  const gotExact = await col.findOne({ _id: 'exact-second' });
  check(
    'an exact-second timestamp keeps its trailing .000 (the STATUS.md bug cannot recur)',
    gotExact.received_at === exact,
    `${gotExact.received_at} vs ${exact}`,
  );

  await col.drop();
}

// ═════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('\nD1 · BYTE-FIDELITY SPIKE');
  const { createRequire } = await import('node:module');
  const driverVersion = createRequire(import.meta.url)('mongodb/package.json').version;
  console.log(`driver ${driverVersion}  node ${process.version}  ` +
              `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(SCRATCH_DB);
  await db.dropDatabase();

  try {
    await proveDriverBehaviour(db);
    await proveMitigations();
    await roundTripChain(db);
    await proveAwkwardPayloads(db);
  } finally {
    await db.dropDatabase();
    await client.close();
    await closePool();
  }

  section('RESULT');
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\n  FAILURES:');
    for (const f of failures) console.log(`    ✗ ${f.name}\n        ${f.detail}`);
    console.log('\n  D1 GATE: NOT MET\n');
    process.exit(1);
  }
  console.log('\n  D1 GATE: MET — MongoDB can hold this envelope byte-identically.\n');
}

main().catch((err) => { console.error('\nD1 spike crashed:', err); process.exit(1); });
