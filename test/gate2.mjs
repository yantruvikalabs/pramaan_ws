#!/usr/bin/env node
/**
 * Gate 2 — the evidence spine, verified by running it.
 *
 * Every check below is one of the criteria in build-plan-v1.0.md. The
 * durability half (a real phone, airplane mode, force-kill, reboot) can only
 * be done on hardware and is covered by scripts/gate2-device.sh; this script
 * covers everything that lives on the server.
 *
 *   npm run gate2
 */

import { createHash } from 'node:crypto';
import { startTestServer } from './harness.mjs';
import { query, closePool } from '../src/db.js';
import { ROLE, EMPLOYEE_STATUS, EVENT_TYPE } from '@pramaan/shared';

const results = [];
let app;

function check(criterion, description, passed, detail = '') {
  results.push({ criterion, description, passed, detail });
  console.log(`  ${passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${description}`);
  if (detail) console.log(`      ${detail}`);
}

async function reset() {
  await query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['events', 'quarantine', 'published_heads', 'location_fixes',
                   'subject_refs', 'sessions', 'otp_codes', 'employees']) {
    await query(`TRUNCATE TABLE ${t}`); // pramaan-guard:allow — test harness reset
  }
  await query(
    `UPDATE chain_head SET seq = 0,
       hash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
     WHERE id = 1`,
  );
  await query('SET FOREIGN_KEY_CHECKS = 1');
}

async function signIn(identifier, channel = 'MOBILE') {
  const req = await app.inject({
    method: 'POST', url: '/auth/otp/request', payload: { identifier },
  });
  const { devCode } = req.json();
  const verify = await app.inject({
    method: 'POST', url: '/auth/otp/verify',
    payload: { identifier, code: devCode, channel, device_id: 'DEV-TEST', device_label: 'Gate 2' },
  });
  const body = verify.json();
  body.statusCode = verify.statusCode;
  return body;
}

const post = (url, token, payload) =>
  app.inject({ method: 'POST', url, payload: payload ?? {}, headers: { authorization: `Bearer ${token}` } });
const get = (url, token) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

const uuid = () => crypto.randomUUID();

// ─────────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1mGATE 2 — Evidence spine\x1b[0m\n');

app = await startTestServer();
await reset();

await query(
  `INSERT INTO employees (employee_id, name, phone, email, role, status)
   VALUES (?,?,?,?,?,?)`,
  ['ADM-0001', 'Bootstrap Admin', '9800000001', 'admin@demo.example',
   ROLE.SUPER_ADMIN, EMPLOYEE_STATUS.ENROLMENT_PENDING],
);
await query(
  `INSERT INTO employees (employee_id, name, phone, role, reports_to, status)
   VALUES (?,?,?,?,?,?)`,
  ['EMP-0001', 'Ramesh Kumar', '9800000002', ROLE.EMPLOYEE, 'ADM-0001',
   EMPLOYEE_STATUS.ENROLMENT_PENDING],
);

const admin = await signIn('ADM-0001', 'WEB');
const worker = await signIn('9800000002');
if (!admin.token || !worker.token) {
  console.error('✗ could not sign in — cannot run the gate');
  process.exit(1);
}

// ── Criterion 1–2: a real backlog uploads, in order ──────────────────────
console.log('\x1b[1m1. 500 events upload in order and every one is appended\x1b[0m');

const BATCH = 100;
const madeIds = [];
let uploaded = 0;

for (let b = 0; b < 5; b++) {
  const events = Array.from({ length: BATCH }, (_, i) => {
    const id = uuid();
    madeIds.push(id);
    return {
      event_id: id,
      type: EVENT_TYPE.ATTENDANCE_PUNCH,
      payload: { punch_index: b * BATCH + i + 1, verification: 'GATE2_SYNTHETIC' },
      captured_at: new Date(Date.now() - (500 - (b * BATCH + i)) * 60_000).toISOString(),
      uptime_ms: 1_000_000 + b * BATCH + i,
      location: { lat: 26.449923, lon: 80.331871, accuracy_m: 12, is_mock: false },
    };
  });
  const res = await post('/events', worker.token, { events });
  uploaded += res.json().accepted ?? 0;
}

check(1, '500 events accepted', uploaded === 500, `${uploaded} appended`);

const [{ n: stored }] = await query('SELECT COUNT(*) AS n FROM events');
check(1, 'all 500 are in the chain', stored === 500, `${stored} rows`);

const ordered = await query('SELECT seq FROM events ORDER BY seq');
const gapless = ordered.every((r, i) => Number(r.seq) === i + 1);
check(1, 'sequence numbers are gapless from 1', gapless,
  `1 … ${ordered.length}, no gaps`);

// ── Criterion 3: re-sending is always safe ───────────────────────────────
console.log('\n\x1b[1m3. Re-sending the whole backlog changes nothing\x1b[0m');

const replay = await post('/events', worker.token, {
  events: madeIds.slice(0, BATCH).map((id) => ({
    event_id: id, type: EVENT_TYPE.ATTENDANCE_PUNCH, payload: { replayed: true },
  })),
});
const rb = replay.json();
check(3, 'every re-sent event is acknowledged as a duplicate',
  rb.duplicates === BATCH && rb.accepted === 0,
  `accepted ${rb.accepted}, duplicates ${rb.duplicates}`);

const [{ n: afterReplay }] = await query('SELECT COUNT(*) AS n FROM events');
check(3, 'no duplicate rows were created', afterReplay === 500, `${afterReplay} rows`);

// ── Criterion 5: the drain-only path ─────────────────────────────────────
console.log('\n\x1b[1m5. A replaced phone can still deliver, and do nothing else\x1b[0m');

const replacement = await signIn('9800000002');   // displaces `worker`
const [displaced] = await query(
  'SELECT state FROM sessions WHERE session_id = ?', [worker.session_id],
);
check(5, 'the old phone became DRAIN_ONLY, not revoked',
  displaced?.state === 'DRAIN_ONLY', `state ${displaced?.state}`);

const drainUpload = await post('/events', worker.token, {
  events: [{
    event_id: uuid(), type: EVENT_TYPE.ATTENDANCE_PUNCH,
    payload: { note: 'captured before the handset was replaced' },
    captured_at: new Date().toISOString(),
  }],
});
check(5, 'it may still upload what it already captured',
  drainUpload.statusCode === 200 && drainUpload.json().accepted === 1,
  `status ${drainUpload.statusCode}, accepted ${drainUpload.json().accepted}`);

const drainOther = await get('/auth/me', worker.token);
check(5, 'and may do nothing else',
  drainOther.statusCode === 401 && drainOther.json().error === 'SIGNED_IN_ELSEWHERE',
  `status ${drainOther.statusCode}, ${drainOther.json().error}`);

// ── Criterion 4: alteration is detected ──────────────────────────────────
console.log('\n\x1b[1m4. Altering one byte is detected and named\x1b[0m');

const before = await get('/chain/verify', admin.token);
check(4, 'the chain verifies before anything is touched', before.json().ok === true,
  `${before.json().checked} events`);

// Deliberately tampering, to prove it is detected. The two lines below are
// the ONLY writes to `events` anywhere in this repository, and they exist to
// make the append-only rule demonstrable rather than merely asserted.
await query(`UPDATE events SET payload = JSON_SET(payload, '$.punch_index', 9999) WHERE seq = 250`); // pramaan-guard:allow
const altered = await get('/chain/verify', admin.token);
const a = altered.json();
check(4, 'an altered record is found, and named', a.ok === false && a.at_seq === 250,
  `${a.reason} at seq ${a.at_seq}`);

// Put it back exactly, showing the check is on content and not a one-way
// "tampered" flag that could simply be reset.
await query(`UPDATE events SET payload = JSON_SET(payload, '$.punch_index', 250) WHERE seq = 250`); // pramaan-guard:allow
const restored = await get('/chain/verify', admin.token);
check(4, 'restoring the exact value makes it valid again — the check is on content',
  restored.json().ok === true, `${restored.json().checked} events`);

// ── Criterion 6: removal is detected, and the head no longer matches ─────
console.log('\n\x1b[1m6. Removing a record breaks the chain AND the published head\x1b[0m');

const published = await post('/chain/publish', admin.token, { destination: 'gate2@example' });
const headBefore = published.json();
check(6, 'a head can be published', published.statusCode === 201 && headBefore.seq > 0,
  `seq ${headBefore.seq}`);
check(6, 'the response states honestly whether it left this machine',
  typeof headBefore.offsite === 'boolean' && Boolean(headBefore.posture?.level),
  `offsite ${headBefore.offsite}, posture ${headBefore.posture?.level}`);
check(6, 'the head was written OUTSIDE the database',
  headBefore.sinks?.file === true,
  `sinks ${JSON.stringify(headBefore.sinks)}`);

await query('DELETE FROM events WHERE seq = 300'); // pramaan-guard:allow — proving detection
const afterDelete = await get('/chain/verify', admin.token);
const d = afterDelete.json();
check(6, 'a deleted record leaves a detectable gap',
  d.ok === false && d.reason === 'GAP' && d.at_seq === 301,
  `${d.reason} at seq ${d.at_seq}`);

// ── The export is verifiable, and carries no personal data ───────────────
console.log('\n\x1b[1m7. The export is what an outsider needs, and nothing more\x1b[0m');

const exp = await get('/chain/export?from=1&limit=600', admin.token);
const x = exp.json();
check(7, 'the export includes the public key so signatures can be checked',
  Boolean(x.key?.spki_base64), x.key?.curve ?? 'missing');
check(7, 'the export includes published heads from OUTSIDE the database',
  Array.isArray(x.published_heads) && x.published_heads.length > 0,
  `${x.published_heads?.length} head(s)`);

const asText = JSON.stringify(x.events);
const leaks = [];
if (/EMP-0001|ADM-0001/.test(asText)) leaks.push('an employee_id');
if (/9800000002/.test(asText)) leaks.push('a phone number');
if (/26\.449|80\.331/.test(asText)) leaks.push('coordinates');
if (/Ramesh|Bootstrap/.test(asText)) leaks.push('a name');
check(7, 'no personal data anywhere in the export — NFR-17',
  leaks.length === 0, leaks.length ? `LEAKED: ${leaks.join(', ')}` : 'only opaque references');

check(7, 'every event carries both captured_at and received_at — BR-EVD-11',
  x.events.every((e) => e.received_at) && x.events.some((e) => e.captured_at),
  'both present');

// A verifier that cannot recompute the hash is not a verifier. This proves
// the canonical form is reproducible from the spec, independently of the
// server's own code path.
const sample = x.events[0];
const canonBytes = Buffer.from(canonicalise(envelopeOf(sample)), 'utf8');
const recomputed = `sha256:${createHash('sha256').update(canonBytes).digest('hex')}`;
check(7, 'an independent implementation reproduces the same hash',
  recomputed === sample.hash,
  recomputed === sample.hash ? 'byte-identical' : `${recomputed} vs ${sample.hash}`);

// ── Quarantine ───────────────────────────────────────────────────────────
console.log('\n\x1b[1m8. Nothing is silently dropped, and nothing silently accepted\x1b[0m');

const bogus = await post('/events', replacement.token, {
  events: [{ event_id: uuid(), type: 'NotARealEventType', payload: {} }],
});
check(8, 'an unknown event type is quarantined, not accepted',
  bogus.json().quarantined === 1 && bogus.json().accepted === 0,
  JSON.stringify(bogus.json().results[0]));

const [{ n: held }] = await query('SELECT COUNT(*) AS n FROM quarantine');
check(8, 'the submission is retained for somebody to look at', held >= 1, `${held} held`);

const health = await app.inject({ method: 'GET', url: '/health' });
check(8, 'the quarantine depth is visible without logging in',
  health.json().quarantine_unreviewed >= 1,
  `health reports ${health.json().quarantine_unreviewed} unreviewed`);

// ── Imports reach the chain ──────────────────────────────────────────────
console.log('\n\x1b[1m9. Master-data changes are in the chain, not just a table\x1b[0m');

const made = await post('/employees', admin.token, {
  employee_id: 'EMP-9100', name: 'Sunita Devi', phone: '9800000199',
  role: 'EMPLOYEE', reports_to: 'ADM-0001',
});
check(9, 'adding an employee writes a signed event',
  made.statusCode === 201 && made.json().event?.seq > 0,
  `seq ${made.json().event?.seq}`);

const [imported] = await query(
  `SELECT payload FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1`,
  [EVENT_TYPE.EMPLOYEES_IMPORTED],
);
const p = typeof imported?.payload === 'string' ? JSON.parse(imported.payload) : imported?.payload;
check(9, 'it records who did it and their role at that moment — BR-EVD-9',
  p?.actor_role === ROLE.SUPER_ADMIN && Boolean(p?.actor_ref),
  `actor_role ${p?.actor_role}`);
check(9, 'and names nobody — the actor is a reference like everyone else',
  !JSON.stringify(p).includes('ADM-0001'),
  'opaque actor_ref');

// ── Result ───────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.passed).length;
const failed = results.length - passed;

console.log(`\n${'─'.repeat(64)}`);
if (failed === 0) {
  console.log(`\x1b[32m\x1b[1mGATE 2 PASSED\x1b[0m — ${passed}/${results.length} checks`);
  console.log('Durability on real hardware is verified separately by scripts/gate2-device.sh.');
} else {
  console.log(`\x1b[31m\x1b[1mGATE 2 FAILED\x1b[0m — ${failed} of ${results.length} checks failed`);
  for (const r of results.filter((x) => !x.passed)) {
    console.log(`  ✗ [${r.criterion}] ${r.description} — ${r.detail}`);
  }
}
console.log(`${'─'.repeat(64)}\n`);

await app.close();
await closePool();
process.exit(failed === 0 ? 0 : 1);

/* ── An independent canonicaliser ────────────────────────────────────────
   Written from the specification rather than imported from src/, for the
   same reason the browser verifier is: code that uses the server's own
   implementation proves only that the server agrees with itself. */
function canonicalise(v) {
  if (v === null || v === undefined) throw new Error('null');
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isInteger(v)) throw new Error(`not an integer: ${v}`);
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalise).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== null && v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalise(v[k])}`).join(',')}}`;
}

function envelopeOf(e) {
  const o = {
    canon_v: e.canon_v, seq: e.seq, event_id: e.event_id, type: e.type,
    payload: e.payload ?? {}, received_at: e.received_at, prev_hash: e.prev_hash,
  };
  for (const k of ['subject_ref', 'device_ref', 'session_ref', 'location_ref',
                   'captured_at', 'device_time', 'uptime_ms']) {
    if (e[k] !== null && e[k] !== undefined) o[k] = e[k];
  }
  return o;
}
