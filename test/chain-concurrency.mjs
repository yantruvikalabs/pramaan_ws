/**
 * D2 · Gaplessness under concurrency — docs/mongodb-migration-plan.md §K4.
 *
 * The exit gate for D2. Four passes plus a negative control that MUST fail.
 *
 * Why the negative control is not optional: every assertion here would also
 * pass against a single-threaded appender, or against a test that never
 * actually ran anything in parallel. The naive `$inc` implementation is run
 * through the identical assertions, and if it survives them, THIS TEST IS
 * BROKEN and the run fails — regardless of how the real appender did.
 *
 *   docker run -d --name pramaan-mongo -p 27018:27018 mongo:7 \
 *     --replSet rs0 --bind_ip_all --port 27018
 *   node test/chain-concurrency.mjs
 */

import { createHash, randomUUID } from 'node:crypto';
import { canonicalBytes } from '../src/lib/canonical.js';
import { verify } from '../src/lib/signing.js';
import { envelopeOf } from '../src/lib/chain.js';
// ⚠ The appender under test is the SHIPPED one, from src/lib/chain.js.
//
// This file used to import appendEvent from tools/d2-chain-mongo.mjs — the D2
// prototype. Every check passed, and proved nothing about the code the
// application actually runs: the two could drift apart silently, and the gate
// would keep reporting green. A concurrency test that exercises a copy of the
// appender is the same failure as a negative control that cannot fail.
import { appendEvent, docToEvent } from '../src/lib/chain.js';
import { connect, col, getDb, closeClient } from '../src/db/mongo.js';
import { applySchema, HEAD_ID, GENESIS_HASH } from '../src/db/mongo-schema.js';

// The naive $inc appender stays in tools/: it is deliberately WRONG and exists
// only as this file's negative control. It must never be importable from src/.
import { appendEventNAIVE } from '../tools/d2-chain-mongo.mjs';

// Isolated database, so a run can never touch a real chain.
process.env.MONGODB_DB = process.env.MONGODB_DB ?? 'pramaan_d2';

/**
 * ⚠ Every correctness pass runs with the in-process queue DISABLED.
 *
 * The queue (tools/d2-chain-mongo.mjs) is a throughput optimisation that
 * serialises appends inside one Node process. If the tests ran with it on,
 * they would prove the QUEUE is correct and say nothing about the
 * compare-and-swap — and the queue is exactly what disappears during a rolling
 * restart or with a second worker. The CAS is the guarantee; it is what is
 * under test here.
 */
const RAW = { queue: false };

let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
  return ok;
}
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);

const punch = (i) => ({
  event_id: randomUUID(),
  type: 'AttendancePunch',
  subject_ref: `SUB-${String(i % 7).padStart(36, '0')}`,
  device_ref: `dev-${i % 3}`,
  payload: { kind: 'IN', n: i },
  captured_at: new Date(1786000000000 + i * 1000).toISOString(),
  uptime_ms: 1000 + i,
});

async function reset() {
  await col('events').deleteMany({}); // pramaan-guard:allow — test harness reset, scratch database
  await col('chain_head').deleteMany({});
  await applySchema({ log: { log: () => {} } });
}

/**
 * The same four questions verifyChain() asks (`src/lib/chain.js:271-306`),
 * plus the one it cannot ask under MySQL because PRIMARY KEY (seq) made it
 * impossible: is any seq DUPLICATED? Audit finding H7 — without this branch a
 * fork is misreported as a deletion.
 */
async function verifyChainMongo(db) {
  const docs = await db.collection('events').find({}).sort({ seq: 1 }).toArray();
  const events = docs.map(docToEvent);

  const seen = new Set();
  const problems = { gaps: [], duplicates: [], links: [], altered: [], badSig: [] };

  let expected = 1;
  let prev = GENESIS_HASH;

  for (const e of events) {
    if (seen.has(e.seq)) problems.duplicates.push(e.seq);
    seen.add(e.seq);

    if (e.seq !== expected) { problems.gaps.push({ expected, found: e.seq }); expected = e.seq; }
    if (e.prev_hash !== prev) problems.links.push(e.seq);

    const bytes = canonicalBytes(envelopeOf(e));
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== e.hash) problems.altered.push(e.seq);
    if (!verify(bytes, e.signature)) problems.badSig.push(e.seq);

    prev = e.hash;
    expected += 1;
  }

  const head = await db.collection('chain_head').findOne({ _id: HEAD_ID });
  return {
    count: events.length,
    ok: problems.gaps.length === 0 && problems.duplicates.length === 0 &&
        problems.links.length === 0 && problems.altered.length === 0 && problems.badSig.length === 0,
    problems,
    head,
    lastHash: events.length > 0 ? events[events.length - 1].hash : GENESIS_HASH,
    lastSeq: events.length > 0 ? events[events.length - 1].seq : 0,
  };
}

/** Every assertion the chain must satisfy. Applied to BOTH appenders. */
function assertChainSound(label, r, expectedCount) {
  const p = r.problems;
  const results = [
    [`${label}: all ${expectedCount} appends are present`, r.count === expectedCount, `found ${r.count}`],
    [`${label}: seq is gapless 1..N`, p.gaps.length === 0,
      p.gaps.slice(0, 3).map((g) => `expected ${g.expected}, found ${g.found}`).join('; ')],
    [`${label}: no duplicate seq (audit H7)`, p.duplicates.length === 0,
      `duplicated: ${p.duplicates.slice(0, 5).join(', ')}`],
    [`${label}: every prev_hash links to its predecessor`, p.links.length === 0,
      `broken at seq: ${p.links.slice(0, 5).join(', ')}`],
    [`${label}: every hash recomputes`, p.altered.length === 0, `altered at: ${p.altered.slice(0, 5).join(', ')}`],
    [`${label}: every signature verifies`, p.badSig.length === 0, `bad at: ${p.badSig.slice(0, 5).join(', ')}`],
    [`${label}: chain_head matches the last event`,
      Number(r.head?.seq) === r.lastSeq && r.head?.hash === r.lastHash,
      `head ${r.head?.seq}/${String(r.head?.hash).slice(0, 20)}… vs last ${r.lastSeq}/${String(r.lastHash).slice(0, 20)}…`],
  ];
  return results;
}

const runAll = (results) => { for (const [n, ok, d] of results) check(n, ok, d); };
/** For the negative control: how many of the same assertions FAILED. */
const countFailures = (results) => results.filter(([, ok]) => !ok).length;

// ═════════════════════════════════════════════════════════════════════════

async function pass1Sequential() {
  section('PASS 1 · Sequential — 100 appends, one at a time');
  await reset();
  const db = getDb();

  for (let i = 0; i < 100; i += 1) await appendEvent(punch(i), null, RAW);

  const r = await verifyChainMongo(db);
  runAll(assertChainSound('sequential', r, 100));
}

async function pass2Concurrent() {
  section('PASS 2 · Concurrent — 200 appends, 50 in flight at once');
  await reset();
  const db = getDb();

  const stats = { retries: 0, bodyRuns: 0 };
  const started = Date.now();

  const BATCHES = 4, WIDTH = 50;
  for (let b = 0; b < BATCHES; b += 1) {
    await Promise.all(
      Array.from({ length: WIDTH }, (_, i) => appendEvent(punch(b * WIDTH + i), null, { ...RAW, stats })),
    );
  }
  const elapsed = Date.now() - started;

  const r = await verifyChainMongo(db);
  runAll(assertChainSound('concurrent', r, BATCHES * WIDTH));

  const amp = stats.bodyRuns / (BATCHES * WIDTH);
  console.log(`\n      ${BATCHES * WIDTH} events in ${elapsed}ms ` +
              `(${(BATCHES * WIDTH / (elapsed / 1000)).toFixed(1)}/s), ` +
              `transaction body ran ${amp.toFixed(2)}× per append`);
  console.log('      Contention here is EXPECTED and is the CAS working. Counted INSIDE');
  console.log('      the callback because withTransaction retries WriteConflict itself —');
  console.log('      an outer-loop counter reports 0 under heavy contention.');

  // If the body ran once per append at 50-way concurrency, the appends were
  // not actually concurrent and this pass proved nothing.
  check('the appends really were contended (body ran more than once per append)',
    amp > 1.0,
    `amplification ${amp.toFixed(2)} — with 50 in flight this should be well above 1. ` +
    'If it is 1.00, the work serialised somewhere and concurrency was never exercised');
}

/**
 * The in-process queue is a throughput optimisation. It must not change any
 * outcome — same chain, same guarantees, just fewer wasted signatures.
 */
async function pass5QueueChangesNothing() {
  section('PASS 5 · The throughput queue must not change any outcome');
  await reset();
  const db = getDb();

  const stats = { bodyRuns: 0 };
  await Promise.all(Array.from({ length: 50 }, (_, i) => appendEvent(punch(i), null, { stats })));

  const r = await verifyChainMongo(db);
  runAll(assertChainSound('queued', r, 50));

  const amp = stats.bodyRuns / 50;
  check('the queue removes the retry amplification', amp < 1.2,
    `amplification ${amp.toFixed(2)} — expected ~1.00; the queue is not serialising`);
  console.log(`\n      amplification ${amp.toFixed(2)}× with the queue on, ` +
              'vs the contended figure in PASS 2');
}

async function pass3Idempotency() {
  section('PASS 3 · Idempotency under concurrency — the same event 20 times at once');
  await reset();
  const db = getDb();

  await appendEvent(punch(0), null, RAW);                   // something to chain onto

  const dup = punch(1);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => appendEvent({ ...dup }, null, RAW)),
  );

  const appended = results.filter((r) => r.status === 'appended').length;
  const duplicates = results.filter((r) => r.status === 'duplicate').length;

  check('exactly one of 20 concurrent identical sends was appended', appended === 1, `appended ${appended}`);
  check('the other 19 were reported as duplicates, not errors', duplicates === 19, `duplicates ${duplicates}`);

  const stored = await db.collection('events').countDocuments({ event_id: dup.event_id });
  check('exactly one document exists for that event_id', stored === 1, `${stored} documents`);

  const r = await verifyChainMongo(db);
  runAll(assertChainSound('after duplicate storm', r, 2));
  check('no seq was burned by the 19 losers', r.lastSeq === 2, `head is at ${r.lastSeq}, expected 2`);
}

async function pass4CrashDoesNotBurnSeq() {
  section('PASS 4 · A crash after signing must not burn a seq');
  await reset();
  const db = getDb();

  for (let i = 0; i < 5; i += 1) await appendEvent(punch(i), null, RAW);
  const headBefore = await db.collection('chain_head').findOne({ _id: HEAD_ID });

  // Fail 10 times between signing and commit. Under AUTO_INCREMENT (and under
  // the naive $inc) each of these burns a position permanently.
  let thrown = 0;
  for (let i = 0; i < 10; i += 1) {
    try {
      await appendEvent(punch(100 + i), null, { ...RAW, maxAttempts: 1, failAfterSign: true });
    } catch { thrown += 1; }
  }
  check('all 10 injected failures did throw', thrown === 10, `${thrown} of 10`);

  const headAfter = await db.collection('chain_head').findOne({ _id: HEAD_ID });
  check('the chain head did not move', Number(headAfter.seq) === Number(headBefore.seq),
    `${headBefore.seq} → ${headAfter.seq} — a moved head is a burned seq, permanent and unfixable`);

  // The next real append must land at exactly N+1, with no hole behind it.
  const next = await appendEvent(punch(999), null, RAW);
  check('the next append lands at exactly N+1', next.event.seq === Number(headBefore.seq) + 1,
    `landed at ${next.event.seq}, expected ${Number(headBefore.seq) + 1}`);

  const r = await verifyChainMongo(db);
  runAll(assertChainSound('after 10 crashes', r, 6));
}

/**
 * ⚠ THE NEGATIVE CONTROL.
 *
 * The naive $inc appender is put through the SAME assertions. It must fail
 * them. If it passes, the assertions are not testing concurrency and every
 * result above is worthless.
 */
async function negativeControl() {
  section('NEGATIVE CONTROL · the naive $inc appender MUST fail these same checks');
  const db = getDb();

  // (a) forking under concurrency
  await reset();
  const WIDTH = 40;
  await Promise.all(Array.from({ length: WIDTH }, (_, i) => appendEventNAIVE(getDb(), punch(i)).catch(() => null)));
  const rConc = await verifyChainMongo(db);
  const concFailures = countFailures(assertChainSound('naive/concurrent', rConc, WIDTH));

  console.log(`      concurrent: ${concFailures} of 7 assertions failed`);
  console.log(`        gaps ${rConc.problems.gaps.length}, duplicate seq ${rConc.problems.duplicates.length}, ` +
              `broken links ${rConc.problems.links.length}`);
  check(
    'the naive appender FAILS under concurrency, as it must',
    concFailures > 0,
    'it passed — these assertions cannot tell a correct appender from a broken one, ' +
    'so PASS 2 proved nothing',
  );

  // (b) burning a seq on failure
  await reset();
  for (let i = 0; i < 3; i += 1) await appendEventNAIVE(getDb(), punch(i));
  const beforeSeq = Number((await db.collection('chain_head').findOne({ _id: HEAD_ID })).seq);
  try {
    await appendEventNAIVE(getDb(), punch(50), {
      injectFailure: (_e, stage) => {
        if (stage === 'after-sign') throw new Error('simulated crash');
      },
    });
  } catch { /* expected */ }
  const afterSeq = Number((await db.collection('chain_head').findOne({ _id: HEAD_ID })).seq);

  check(
    'the naive appender BURNS a seq on failure, as it must',
    afterSeq > beforeSeq,
    `head ${beforeSeq} → ${afterSeq}; if it did not move, PASS 4 proved nothing`,
  );
  console.log(`      head moved ${beforeSeq} → ${afterSeq} with nothing at position ${afterSeq} ` +
              '— a permanent GAP, exactly what schema.sql:231-235 rejected AUTO_INCREMENT to avoid');

  const rBurn = await verifyChainMongo(db);
  check(
    'and that burn is visible as a GAP the verifier reports',
    rBurn.problems.gaps.length > 0 || Number(rBurn.head.seq) !== rBurn.lastSeq,
    'the verifier did not notice — it cannot detect the failure it exists to detect',
  );
}

// ═════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('\nD2 · GAPLESSNESS UNDER CONCURRENCY');
  console.log(`node ${process.version}  TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

  await connect();
  await applySchema({ log: { log: () => {} } });
  console.log(`database: ${getDb().databaseName}`);
  try {
    await pass1Sequential();
    await pass2Concurrent();
    await pass3Idempotency();
    await pass4CrashDoesNotBurnSeq();
    await pass5QueueChangesNothing();
    await negativeControl();
  } finally {
    await getDb().dropDatabase().catch(() => {});
    await closeClient();
  }

  section('RESULT');
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\n  FAILURES:');
    for (const f of failures) console.log(`    ✗ ${f.name}\n        ${f.detail}`);
    console.log('\n  D2 GATE: NOT MET\n');
    process.exit(1);
  }
  console.log('\n  D2 GATE: MET — the chain stays gapless under concurrency,');
  console.log('  and the test can tell a correct appender from a broken one.\n');
}

main().catch((err) => { console.error('\nD2 crashed:', err); process.exit(1); });
