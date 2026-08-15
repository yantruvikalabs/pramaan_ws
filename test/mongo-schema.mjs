/**
 * The MongoDB schema — proving it enforces what MySQL used to.
 *
 * Kept as .mjs rather than .test.js on purpose: it needs a live replica set,
 * and `npm test` must stay pure and runnable with nothing installed.
 *
 *   npm run test:mongo-schema
 *
 * Two thirds of this file is negative controls. A validator that has never
 * rejected anything, and an append-only assertion that has never fired, are
 * indistinguishable from no validator and no assertion at all.
 */

import { connect, closeClient, getDb, col } from '../src/db/mongo.js';
import { applySchema, assertEventsCollectionSafe, assertReferentialIntegrity } from '../src/db/mongo-schema.js';

let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);

/** Did this write get rejected? Returns the error code, or null if it succeeded. */
async function rejected(fn) {
  try { await fn(); return null; } catch (e) { return e.code ?? e.codeName ?? e.message; }
}

const employee = (id, extra = {}) => ({
  _id: id, name: `Person ${id}`, phone: `+9199${String(id).padStart(8, '0')}`,
  role: 'EMPLOYEE', status: 'ENROLMENT_PENDING', language: 'hi',
  reports_to: null, email: null, created_at: new Date(), updated_at: new Date(),
  ...extra,
});

async function testUniqueness() {
  section('Unique indexes — still enforced by the database');

  await col('employees').deleteMany({});

  const first = employee('E1');
  await col('employees').insertOne(first);
  // Take the phone from the inserted document rather than writing one out:
  // the first version hard-coded a literal that the helper never generates,
  // so the "duplicate" was not a duplicate and the check passed vacuously.
  const dupPhone = await rejected(() =>
    col('employees').insertOne(employee('E2', { phone: first.phone })));
  check('a duplicate phone is rejected — one number is one person',
    dupPhone === 11000, `got ${dupPhone}`);

  await col('employees').insertOne(employee('E3', { email: 'a@example.com' }));
  const dupEmail = await rejected(() =>
    col('employees').insertOne(employee('E4', { email: 'a@example.com' })));
  check('a duplicate email is rejected', dupEmail === 11000, `got ${dupEmail}`);

  // ── The partial filter, which has no MySQL analogue ────────────────────
  // MySQL allows repeated NULLs in a unique index. MongoDB treats a missing
  // or null field as a value, so WITHOUT partialFilterExpression the second
  // employee with no email is rejected — and most of this workforce (cleaners,
  // guards, food handlers) has no email address at all. That would break the
  // 2,000-row import on row two.
  await col('employees').deleteMany({});
  const many = await rejected(async () => {
    for (let i = 0; i < 5; i += 1) await col('employees').insertOne(employee(`N${i}`));
  });
  check('MANY employees may have no email — the partial index preserves MySQL NULL semantics',
    many === null, `rejected with ${many}`);
  check('and all five are stored', await col('employees').countDocuments({}) === 5);

  // Explicit null must behave the same as absent — the importer writes null.
  const explicitNulls = await rejected(async () => {
    await col('employees').insertOne(employee('X1', { email: null }));
    await col('employees').insertOne(employee('X2', { email: null }));
  });
  check('explicit nulls behave like absent emails', explicitNulls === null, `rejected with ${explicitNulls}`);
}

async function testValidators() {
  section('Validators — what the 8 ENUMs used to make impossible');

  await col('employees').deleteMany({});

  const badRole = await rejected(() => col('employees').insertOne(employee('B1', { role: 'ADMINISTRATOR' })));
  check('an unknown role is rejected', badRole === 121 || badRole === 'DocumentFailedValidation', `got ${badRole}`);

  const badStatus = await rejected(() => col('employees').insertOne(employee('B2', { status: 'enrolled' })));
  check('a mis-cased status is rejected — case matters', badStatus !== null, `got ${badStatus}`);

  await col('sessions').deleteMany({});
  const okSession = {
    _id: 'sess-1', employee_id: 'E1', channel: 'MOBILE', state: 'ACTIVE',
    last_seen_at: new Date(), created_at: new Date(), reason: null,
  };
  check('a valid session is accepted', await rejected(() => col('sessions').insertOne(okSession)) === null);

  const badState = await rejected(() =>
    col('sessions').insertOne({ ...okSession, _id: 'sess-2', state: 'revoked' }));
  check('a mis-cased session state is rejected — middleware/auth.js checks by exclusion',
    badState !== null, `got ${badState}`);

  await col('location_fixes').deleteMany({});
  const numericMock = await rejected(() =>
    col('location_fixes').insertOne({ _id: 'LOC-1', lat: 12.9, lon: 77.5, is_mock: 1 }));
  check('is_mock must be a real boolean, not 1 — the type that broke refs.js',
    numericMock !== null, `got ${numericMock}`);
}

async function testAppendOnlySafety() {
  section('Append-only safety — and it must be able to FAIL');

  const db = getDb();

  let ok = true;
  try { await assertEventsCollectionSafe(); } catch (e) { ok = false; }
  check('a healthy events collection passes the safety check', ok);

  // ── NEGATIVE CONTROL 1 · a TTL index ──────────────────────────────────
  // No source-code guard can see this. It deletes records on a timer with no
  // code to review and no trace.
  // On captured_at_d, which carries no index of its own. Using received_at_d
  // collides with idx_events_received (IndexOptionsConflict) — a small
  // accidental obstacle for anyone adding a TTL, and not one to rely on: any
  // unindexed field works, as does dropping the existing index first.
  await db.collection('events').createIndex({ captured_at_d: 1 }, { name: 'evil_ttl', expireAfterSeconds: 60 });
  let ttlCaught = null;
  try { await assertEventsCollectionSafe(); } catch (e) { ttlCaught = e.message; }
  check('a TTL index on events is CAUGHT', ttlCaught !== null && /TTL/.test(ttlCaught),
    ttlCaught ?? 'NOT CAUGHT — the chain could be deleted on a timer, silently');
  await db.collection('events').dropIndex('evil_ttl');

  let recovered = true;
  try { await assertEventsCollectionSafe(); } catch { recovered = false; }
  check('and the check passes again once it is removed (no false positive)', recovered);

  // ── NEGATIVE CONTROL 2 · a capped collection ──────────────────────────
  // A capped collection silently drops the OLDEST documents — which in an
  // evidence chain is precisely the records somebody would want gone.
  const scratch = `events_capped_probe`;
  await db.createCollection(scratch, { capped: true, size: 4096 });
  const [info] = await db.listCollections({ name: scratch }).toArray();
  check('a capped collection is detectable via listCollections', info?.options?.capped === true);
  await db.collection(scratch).drop();
}

async function testReferentialIntegrity() {
  section('Referential integrity — what the foreign keys used to guarantee');

  await col('employees').deleteMany({});
  await col('sessions').deleteMany({});
  await col('otp_codes').deleteMany({});

  await col('employees').insertOne(employee('MGR'));
  await col('employees').insertOne(employee('EMP', { reports_to: 'MGR' }));
  const clean = await assertReferentialIntegrity();
  check('a sound hierarchy reports ok', clean.ok, JSON.stringify(clean.problems));

  // ── NEGATIVE CONTROL · the orphan MySQL made impossible ───────────────
  // fk_employees_reports_to was ON DELETE RESTRICT so that deactivating an
  // employee could never remove anybody. Nothing enforces that now.
  await col('employees').insertOne(employee('ORPHAN', { reports_to: 'NOBODY' }));
  const orphaned = await assertReferentialIntegrity();
  check('an employee reporting to a missing manager is CAUGHT',
    !orphaned.ok && orphaned.problems.some((p) => p.constraint === 'fk_employees_reports_to'),
    JSON.stringify(orphaned.problems));

  await col('sessions').insertOne({
    _id: 'ghost', employee_id: 'GONE', channel: 'WEB', state: 'ACTIVE',
    last_seen_at: new Date(), reason: null,
  });
  const ghost = await assertReferentialIntegrity();
  check('a session naming a missing employee is CAUGHT',
    ghost.problems.some((p) => p.constraint === 'fk_sessions_employee'),
    JSON.stringify(ghost.problems));
}

async function main() {
  console.log('\nMONGO SCHEMA — enforcement checks');

  process.env.MONGODB_DB = process.env.MONGODB_DB ?? 'pramaan_schema_test';
  await connect();
  await getDb().dropDatabase();
  await applySchema({ log: { log: () => {} } });
  console.log(`database: ${getDb().databaseName}`);

  try {
    await testUniqueness();
    await testValidators();
    await testAppendOnlySafety();
    await testReferentialIntegrity();
  } finally {
    await getDb().dropDatabase();
    await closeClient();
  }

  section('RESULT');
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const f of failures) console.log(`    ✗ ${f.name}\n        ${f.detail}`);
    process.exit(1);
  }
  console.log('\n  Schema enforces what MySQL used to, and the checks can fail.\n');
}

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
