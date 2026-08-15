/**
 * MySQL → MongoDB, all 11 tables.
 *
 *   npm run migrate:to-mongo
 *   npm run migrate:to-mongo -- --drop      wipe the target first
 *
 * ⚠ THE CHAIN IS COPIED VERBATIM, NEVER RECOMPUTED.
 *
 * `seq`, `prev_hash`, `hash` and `signature` are stored columns and are moved
 * as they are. Nothing here re-signs anything, and nothing may ever be added
 * that does: re-signing is precisely what the verifier page calls "THE SERVER
 * REWROTE HISTORY". A migration that does not re-sign cannot invalidate a
 * record — it can only fail to reproduce the bytes, and that is detectable
 * 100% of the time, which is what the exit gate below checks.
 *
 * The gate is byte equality, not "it verifies". A systematic error — a
 * timezone shift, a trimmed .000, a Long promotion — produces a chain that
 * verifies perfectly against itself while disagreeing with a head somebody
 * already holds. From outside, that is indistinguishable from tampering.
 */

import { createHash } from 'node:crypto';
import { query, closePool } from '../src/db.js';
import { connect, closeClient, getDb, col } from '../src/db/mongo.js';
import { applySchema, assertEventsCollectionSafe, assertReferentialIntegrity, HEAD_ID, GENESIS_HASH }
  from '../src/db/mongo-schema.js';
import { envelopeOf, rowToEvent, verifyEvents } from '../src/lib/chain.js';
import { canonicalBytes } from '../src/lib/canonical.js';
import { config } from '../src/config.js';

const DROP = process.argv.includes('--drop');
const sha256 = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** MySQL DATETIME(3) string → Date, always read as UTC. */
const toDate = (v) => (v === null || v === undefined ? null : new Date(`${String(v).replace(' ', 'T')}Z`));
const asJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

let moved = 0;
const report = [];

async function move(table, collection, mapper, { sort = null } = {}) {
  const rows = await query(`SELECT * FROM ${table}${sort ? ` ORDER BY ${sort}` : ''}`);
  if (rows.length === 0) {
    report.push({ table, collection, rows: 0, note: 'empty' });
    return [];
  }
  const docs = rows.map(mapper);
  await col(collection).insertMany(docs, { ordered: true });
  moved += docs.length;
  report.push({ table, collection, rows: docs.length });
  return { rows, docs };
}

async function main() {
  console.log('\nMIGRATE · MySQL → MongoDB');
  console.log(`  from  mysql://${config.db.host}:${config.db.port}/${config.db.database}`);
  console.log(`  to    ${config.mongo.database}\n`);

  await connect();
  if (DROP) {
    await getDb().dropDatabase();
    console.log('  --drop: target database wiped\n');
  }
  await applySchema({ log: { log: () => {} } });

  // ── Master data ────────────────────────────────────────────────────────

  await move('employees', 'employees', (r) => ({
    _id: r.employee_id,
    name: r.name,
    phone: r.phone,
    // null, not undefined: the partial unique index keys on `$type: string`,
    // and an explicit null must read back as null rather than as a missing key.
    email: r.email ?? null,
    role: r.role,
    reports_to: r.reports_to ?? null,
    status: r.status,
    language: r.language,
    created_at: toDate(r.created_at),
    updated_at: toDate(r.updated_at),
  }));

  await move('otp_codes', 'otp_codes', (r) => ({
    employee_id: r.employee_id,
    code_hash: r.code_hash,
    channel: r.channel,
    expires_at: toDate(r.expires_at),
    attempts: Number(r.attempts),
    consumed_at: toDate(r.consumed_at),
    created_at: toDate(r.created_at),
  }));

  await move('sessions', 'sessions', (r) => ({
    _id: r.session_id,
    employee_id: r.employee_id,
    channel: r.channel,
    state: r.state,
    device_id: r.device_id ?? null,
    device_label: r.device_label ?? null,
    reason: r.reason ?? null,
    created_at: toDate(r.created_at),
    last_seen_at: toDate(r.last_seen_at),
    ended_at: toDate(r.ended_at),
  }));

  await move('import_batches', 'import_batches', (r) => ({
    _id: r.batch_id,
    imported_by: r.imported_by,
    file_name: r.file_name ?? null,
    file_sha256: r.file_sha256,
    total_rows: Number(r.total_rows),
    accepted: Number(r.accepted),
    rejected: Number(r.rejected),
    report: asJson(r.report),
    created_at: toDate(r.created_at),
  }));

  // ── The reference tables. Deletable on purpose — this is what makes
  //    erasure possible without touching the chain (NFR-17).
  await move('subject_refs', 'subject_refs', (r) => ({
    _id: r.subject_ref,
    employee_id: r.employee_id,
    created_at: toDate(r.created_at),
  }));

  await move('location_fixes', 'location_fixes', (r) => ({
    _id: r.location_ref,
    // DECIMAL(9,6) arrives from mysql2 as a STRING. Number() here, or every
    // coordinate lands as a string and route matching silently compares text.
    lat: r.lat === null ? null : Number(r.lat),
    lon: r.lon === null ? null : Number(r.lon),
    accuracy_m: r.accuracy_m === null ? null : Number(r.accuracy_m),
    // A real boolean. TINYINT(1) 1/0 → true/false, and every read uses
    // Boolean() rather than `=== 1` (lib/refs.js toLocation).
    is_mock: Boolean(r.is_mock),
    created_at: toDate(r.created_at),
  }));

  // ── The chain ──────────────────────────────────────────────────────────

  const events = await move('events', 'events', (r) => {
    const e = rowToEvent(r);              // the SAME mapper the app reads with
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
      // ⚠ The exact ISO strings that were SIGNED. Not Dates. Converting these
      //   is how every event in a chain silently shifts by a timezone offset.
      captured_at: e.captured_at,
      received_at: e.received_at,
      // Parallel Dates, for querying only. Never canonicalised.
      captured_at_d: e.captured_at ? new Date(e.captured_at) : null,
      received_at_d: new Date(e.received_at),
      device_time: e.device_time,
      uptime_ms: e.uptime_ms,
      canon_v: e.canon_v,
      prev_hash: e.prev_hash,
      hash: e.hash,
      signature: e.signature,
    };
  }, { sort: 'seq ASC' });

  const headRows = await query('SELECT seq, hash, updated_at FROM chain_head WHERE id = 1');
  const head = headRows[0] ?? { seq: 0, hash: GENESIS_HASH };
  await col('chain_head').replaceOne(
    { _id: HEAD_ID },
    { _id: HEAD_ID, seq: Number(head.seq), hash: head.hash, updated_at: toDate(head.updated_at) ?? new Date() },
    { upsert: true },
  );

  await move('published_heads', 'published_heads', (r) => ({
    seq: Number(r.seq),
    hash: r.hash,
    signature: r.signature,
    published_at: toDate(r.published_at),
    destination: r.destination,
  }));

  await move('quarantine', 'quarantine', (r) => ({
    event_id: r.event_id ?? null,
    reason: r.reason,
    detail: r.detail ?? null,
    submission: asJson(r.submission),
    session_ref: r.session_ref ?? null,
    received_at: toDate(r.received_at),
    reviewed_at: toDate(r.reviewed_at),
  }));

  await move('face_templates', 'face_templates', (r) => ({
    employee_id: r.employee_id,
    capture_index: Number(r.capture_index),
    model: r.model,
    dimensions: Number(r.dimensions),
    // A Node Buffer becomes BSON binData and comes back a Buffer, because the
    // client sets promoteBuffers:true. Without it, lib/embed.js reads .length
    // as a method and computes new Array(NaN).
    embedding: r.embedding,
    channel: r.channel,
    enrolled_by: r.enrolled_by,
    created_at: toDate(r.created_at),
    face_px: r.face_px === null ? null : Number(r.face_px),
    face_brightness: r.face_brightness === null ? null : Number(r.face_brightness),
    sharpness: r.sharpness === null ? null : Number(r.sharpness),
    off_centre: r.off_centre === null ? null : Number(r.off_centre),
    detector_score: r.detector_score === null ? null : Number(r.detector_score),
    advised_issues: r.advised_issues ?? null,
  }));

  // ── Report ─────────────────────────────────────────────────────────────

  console.log('  table                 → collection            rows');
  console.log('  ─────────────────────────────────────────────────────');
  for (const r of report) {
    console.log(`  ${r.table.padEnd(21)} → ${r.collection.padEnd(21)} ${String(r.rows).padStart(5)}` +
                `${r.note ? `  (${r.note})` : ''}`);
  }
  console.log(`  ${''.padEnd(45)} ${String(moved).padStart(5)} total\n`);

  // ── THE EXIT GATE ──────────────────────────────────────────────────────

  const problems = [];

  await assertEventsCollectionSafe();

  if (events.rows) {
    const source = events.rows.map(rowToEvent);
    const back = await col('events').find({}).sort({ seq: 1 }).toArray();

    if (back.length !== source.length) {
      problems.push(`event count differs: mysql ${source.length}, mongo ${back.length}`);
    }

    let byteDiff = 0, hashDiff = 0, firstBad = null;
    for (let i = 0; i < Math.min(source.length, back.length); i += 1) {
      const a = canonicalBytes(envelopeOf(source[i]));
      const d = back[i];
      const b = canonicalBytes(envelopeOf({
        seq: Number(d.seq), event_id: d.event_id, type: d.type,
        subject_ref: d.subject_ref ?? null, device_ref: d.device_ref ?? null,
        session_ref: d.session_ref ?? null, location_ref: d.location_ref ?? null,
        payload: d.payload ?? {}, captured_at: d.captured_at ?? null,
        received_at: d.received_at ?? null, device_time: d.device_time ?? null,
        uptime_ms: d.uptime_ms ?? null, canon_v: Number(d.canon_v),
        prev_hash: d.prev_hash,
      }));
      if (!a.equals(b)) { byteDiff += 1; firstBad ??= { seq: source[i].seq, a: a.toString(), b: b.toString() }; }
      if (sha256(b) !== d.hash) hashDiff += 1;
    }
    if (byteDiff > 0) problems.push(`${byteDiff} event(s) do not reproduce byte-identically`);
    if (hashDiff > 0) problems.push(`${hashDiff} event(s) do not match their stored hash`);
    if (firstBad) {
      console.log(`  first divergence at seq ${firstBad.seq}:`);
      console.log(`    mysql ${firstBad.a.slice(0, 200)}`);
      console.log(`    mongo ${firstBad.b.slice(0, 200)}`);
    }

    // Structure must MATCH the source, defects included. A dev chain carries a
    // deliberate gap (test/gate2.mjs deletes seq 300 to prove detection), and a
    // faithful copy of an imperfect chain is a SUCCESS, not a failure.
    const seqs = (list) => JSON.stringify(list.map((e) => Number(e.seq)));
    if (seqs(source) !== seqs(back)) problems.push('the seq sequence was not reproduced exactly');

    const srcVerdict = verifyEvents(source);
    console.log(`  chain: ${source.length} events, source verdict ` +
                `${srcVerdict.ok ? 'ok' : `${srcVerdict.reason} at seq ${srcVerdict.at_seq}`}`);
  }

  const refs = await assertReferentialIntegrity();
  if (!refs.ok) {
    for (const p of refs.problems) console.log(`  ⚠ ${p.constraint}: ${p.detail}`);
  }

  console.log();
  if (problems.length > 0) {
    console.log('  ✗ MIGRATION GATE NOT MET');
    for (const p of problems) console.log(`      ${p}`);
    await closePool(); await closeClient();
    process.exit(1);
  }
  console.log('  ✓ MIGRATION GATE MET — every event reproduces byte-identically.\n');

  await closePool();
  await closeClient();
}

main().catch(async (err) => {
  console.error('\n✗ migration failed:', err);
  await closePool().catch(() => {});
  await closeClient().catch(() => {});
  process.exit(1);
});
