#!/usr/bin/env node
/**
 * Gate 1 — end to end, through the real HTTP layer.
 *
 * Every check below is one of the five criteria in build-plan-v1.0.md. This
 * exists so the gate is verified by running it, not by reading the code and
 * agreeing it looks right.
 *
 * Requires a live database. Run:
 *   npm run db:migrate && node test/gate1.mjs
 */

import { readFile } from 'node:fs/promises';
import { startTestServer } from './harness.mjs';
import { connect, col, closeClient } from '../src/db/mongo.js';
import { applySchema } from '../src/db/mongo-schema.js';
import { ROLE, EMPLOYEE_STATUS } from '@pramaan/shared';

const results = [];
let app;

function check(criterion, description, passed, detail = '') {
  results.push({ criterion, description, passed, detail });
  const mark = passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${description}`);
  if (detail) console.log(`      ${detail}`);
}

async function reset() {
  // No FOREIGN_KEY_CHECKS dance: there are no foreign keys to disable.
  await connect();
  await applySchema({ log: { log: () => {} } });
  for (const c of ['sessions', 'otp_codes', 'import_batches', 'employees']) {
    await col(c).deleteMany({});
  }
}

/**
 * Sign in and return the whole response, exercising the real OTP flow.
 * `identifier` may be a phone number, an email address or an employee ID —
 * the server decides which, and Gate 1 uses all three.
 */
async function signIn(identifier, opts = {}) {
  const req = await app.inject({
    method: 'POST',
    url: '/auth/otp/request',
    payload: { identifier },
  });
  const { devCode } = req.json();
  const verify = await app.inject({
    method: 'POST',
    url: '/auth/otp/verify',
    payload: {
      identifier,
      code: devCode,
      channel: opts.channel ?? 'MOBILE',
      device_id: opts.deviceId,
      device_label: opts.deviceLabel,
    },
  });
  const body = verify.json();
  body.statusCode = verify.statusCode;
  return body;
}

const get = (url, token) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

const post = (url, token, payload) =>
  app.inject({
    method: 'POST', url, payload: payload ?? {},
    headers: { authorization: `Bearer ${token}` },
  });

const importCsv = (token, csv) =>
  app.inject({
    method: 'POST',
    url: '/employees/import',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'text/csv' },
    payload: csv,
  });

// ─────────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1mGATE 1 — Foundation\x1b[0m\n');

app = await startTestServer();
await reset();

// The first super admin is a deployment step, not an API call.
await col('employees').insertOne({
  _id: 'ADM-0001', name: 'Bootstrap Admin', phone: '9800000001',
  email: 'admin@demo-contractor.example', role: ROLE.SUPER_ADMIN,
  reports_to: null, status: EMPLOYEE_STATUS.ENROLMENT_PENDING, language: 'hi',
  created_at: new Date(), updated_at: new Date(),
});

const admin = await signIn('ADM-0001');
if (!admin.token) {
  console.error('✗ could not sign in as the bootstrap admin — cannot run the gate');
  process.exit(1);
}

// ── Criterion 1 ──────────────────────────────────────────────────────────
console.log('\x1b[1m1. Import 2,000 rows — valid created, bad reported by line, batch not failed\x1b[0m');

const cleanCsv = await readFile(new URL('../fixtures/employees-2000.csv', import.meta.url), 'utf8');
const clean = await importCsv(admin.token, cleanCsv);
const cleanBody = clean.json();

check(1, '2,000 clean rows accepted',
  clean.statusCode === 200 && cleanBody.created === 2000,
  `status ${clean.statusCode}, created ${cleanBody.created}, rejected ${cleanBody.rejected}`);

const storedClean = await col('employees').countDocuments({});
check(1, 'all 2,000 are actually in the database',
  storedClean === 2001, `${storedClean} rows (2,000 + the bootstrap admin)`);

await reset();
await col('employees').insertOne({
  _id: 'ADM-0001', name: 'Bootstrap Admin', phone: '9800000001',
  email: 'admin@demo-contractor.example', role: ROLE.SUPER_ADMIN, reports_to: null,
  status: EMPLOYEE_STATUS.ENROLMENT_PENDING, language: 'hi',
  created_at: new Date(), updated_at: new Date(),
});
const admin2 = await signIn('ADM-0001');

const dirtyCsv = await readFile(new URL('../fixtures/employees-2000-dirty.csv', import.meta.url), 'utf8');
const dirty = await importCsv(admin2.token, dirtyCsv);
const d = dirty.json();

check(1, 'a file with bad rows still imports the good ones',
  dirty.statusCode === 200 && d.created >= 2000,
  `created ${d.created}, rejected ${d.rejected}`);

check(1, 'every rejection carries a line number and a readable reason',
  d.rejections.length > 0 &&
  d.rejections.every((r) => Number.isInteger(r.line) && r.errors.length > 0 &&
                            typeof r.errors[0] === 'string' && r.errors[0].length > 5),
  `${d.rejections.length} rejections, all with line + reason`);

const dupPhone = d.rejections.filter((r) =>
  r.errors.some((e) => /Duplicate phone number/i.test(e)));
check(1, 'one number is one person — a shared phone is rejected by line',
  dupPhone.length === 1 && /line \d+/.test(dupPhone[0].errors.find((e) => /Duplicate phone/i.test(e))),
  dupPhone[0]?.errors?.find((e) => /Duplicate phone/i.test(e)) ?? 'not rejected');

const badEmail = d.rejections.filter((r) =>
  r.errors.some((e) => /not a valid email/i.test(e)));
check(1, 'an invalid email address is rejected', badEmail.length === 1,
  `${badEmail.length} rejected`);

const dupEmail = d.rejections.filter((r) =>
  r.errors.some((e) => /Duplicate email|Email already belongs/i.test(e)));
check(1, 'two people cannot share an email address', dupEmail.length === 1,
  dupEmail[0]?.errors?.find((e) => /email/i.test(e)) ?? 'not rejected');

const withEmail = await col('employees').countDocuments({ email: { $nin: [null, ''] } });
check(1, 'emails imported for the staff who have one, blank for those who do not',
  withEmail > 50 && withEmail < 200, `${withEmail} of ${storedClean} have an email`);

// ── Criterion 2 ──────────────────────────────────────────────────────────
console.log('\n\x1b[1m2. A row with a valid Aadhaar is rejected, not stored\x1b[0m');

const blockedRows = d.rejections.filter((r) => r.errors.some((e) => /Aadhaar/i.test(e)));
check(2, 'Aadhaar-bearing rows were rejected',
  blockedRows.length === 2, `${blockedRows.length} rejected for Aadhaar`);

// pramaan-guard:allow — this check EXISTS to prove no Aadhaar-shaped id was
// stored. The MySQL version read as a destructuring pattern and slipped past
// the guard; the Mongo rewrite is a plain assignment, so it needs the marker.
const aadhaarStored = await col('employees').countDocuments({ _id: { $regex: /^[0-9]{12}$/ } }); // pramaan-guard:allow
check(2, 'no 12-digit Aadhaar-shaped id reached the database', aadhaarStored === 0,
  `${aadhaarStored} found`);

const responseText = JSON.stringify(d);
const leaked = /\b[2-9]\d{11}\b/.test(responseText);
check(2, 'the response never echoes the number back', !leaked,
  leaked ? 'A 12-digit value appears in the response' : 'no 12-digit value in the response');

const fileWithColumn = 'employee_id,name,phone,role,aadhaar\nEMP-X,A,9876543210,EMPLOYEE,x\n'; // pramaan-guard:allow
const colRes = await importCsv(admin2.token, fileWithColumn);
check(2, 'a file with an Aadhaar COLUMN is refused entirely',
  colRes.statusCode === 400, `status ${colRes.statusCode}`);

// ── Criterion 4 ──────────────────────────────────────────────────────────
console.log('\n\x1b[1m4. reports_to resolves into a tree; a deliberate cycle is rejected\x1b[0m');

const cycleRejections = d.rejections.filter((r) => r.errors.some((e) => /loop/i.test(e)));
check(4, 'the three-person loop was rejected, all members',
  cycleRejections.length === 3, `${cycleRejections.length} rejected for a loop`);

const danglingRejections = d.rejections.filter((r) =>
  r.errors.some((e) => /does not exist/i.test(e)));
check(4, 'a senior who exists nowhere was reported by name',
  danglingRejections.length === 1, `${danglingRejections.length} rejected`);

// MySQL answered this with NOT EXISTS. There are no foreign keys now, so the
// check matters MORE rather than less — it is the only thing standing where
// fk_employees_reports_to used to.
const orphans = (await col('employees').aggregate([
  { $match: { reports_to: { $ne: null } } },
  { $lookup: { from: 'employees', localField: 'reports_to', foreignField: '_id', as: 'senior' } },
  { $match: { senior: { $size: 0 } } },
  { $count: 'n' },
]).toArray())[0]?.n ?? 0;
check(4, 'no stored employee points at a senior who does not exist', orphans === 0,
  `${orphans} orphans`);

const tree = await col('employees').find({}, { projection: { reports_to: 1 } }).toArray();
const edges = new Map(tree.map((r) => [r._id, r.reports_to]));
let cyclesInDb = 0;
for (const start of edges.keys()) {
  const seen = new Set();
  let cur = start;
  while (cur) {
    if (seen.has(cur)) { cyclesInDb++; break; }
    seen.add(cur);
    cur = edges.get(cur) ?? null;
  }
}
check(4, 'no cycle exists in the stored tree', cyclesInDb === 0, `${cyclesInDb} found`);

// ── Criterion 5 ──────────────────────────────────────────────────────────
console.log('\n\x1b[1m5. Roles — each sees its own sections, others ABSENT not disabled\x1b[0m');

const senior = await signIn('EMP-0006');
const employee = await signIn('EMP-0100');

check(5, 'an employee can sign in and mark their own attendance',
  employee.capabilities?.markOwnAttendance === true &&
  employee.capabilities?.seeTeam === false,
  `role ${employee.employee?.role}, seeTeam ${employee.capabilities?.seeTeam}`);

check(5, 'a senior additionally sees and manages a team',
  senior.capabilities?.seeTeam === true &&
  senior.capabilities?.manageTeam === true &&
  senior.capabilities?.seeAllEmployees === false,
  `role ${senior.employee?.role}`);

check(5, 'an admin sees everyone and can import',
  admin2.capabilities?.seeAllEmployees === true &&
  admin2.capabilities?.importEmployees === true,
  `role ${admin2.employee?.role}`);

const empList = await app.inject({
  method: 'GET', url: '/employees',
  headers: { authorization: `Bearer ${employee.token}` },
});
check(5, 'an employee sees no team list (scope TEAM, empty)',
  empList.json().employees.length === 0, `${empList.json().employees.length} visible`);

const seniorList = await app.inject({
  method: 'GET', url: '/employees',
  headers: { authorization: `Bearer ${senior.token}` },
});
const seniorVisible = seniorList.json().employees;
check(5, 'a senior sees only their own chain, never the whole company',
  seniorList.json().scope === 'TEAM' && seniorVisible.length > 0 && seniorVisible.length < 100,
  `${seniorVisible.length} of ${storedClean} visible`);

const adminList = await app.inject({
  method: 'GET', url: '/employees',
  headers: { authorization: `Bearer ${admin2.token}` },
});
check(5, 'an admin sees everyone',
  adminList.json().scope === 'ALL' && adminList.json().employees.length > 2000,
  `${adminList.json().employees.length} visible`);

const employeeImport = await importCsv(employee.token, 'employee_id,name,phone,role\nX,Y,9876543210,EMPLOYEE\n');
check(5, 'an employee cannot import — 403, not a silent no-op',
  employeeImport.statusCode === 403, `status ${employeeImport.statusCode}`);

const seniorImport = await importCsv(senior.token, 'employee_id,name,phone,role\nX,Y,9876543210,EMPLOYEE\n');
check(5, 'a senior cannot import either', seniorImport.statusCode === 403,
  `status ${seniorImport.statusCode}`);

// ── Criterion 6 ──────────────────────────────────────────────────────────
console.log('\n\x1b[1m6. Sign in by phone, email or employee ID — one device at a time\x1b[0m');

const empRow = await col('employees').findOne({ _id: 'EMP-0100' });
const seniorRow = await col('employees').findOne({ _id: 'EMP-0006' });

const byPhone = await signIn(empRow.phone);
check(6, 'an employee signs in with their phone number',
  Boolean(byPhone.token) && byPhone.employee?.employee_id === 'EMP-0100',
  `resolved to ${byPhone.employee?.employee_id}`);

const byEmail = await signIn(seniorRow.email);
check(6, 'a senior signs in with their email address',
  Boolean(byEmail.token) && byEmail.employee?.employee_id === 'EMP-0006',
  `resolved to ${byEmail.employee?.employee_id} via ${seniorRow.email}`);

check(6, 'employee ID still works as an identifier',
  Boolean((await signIn('ADM-0001')).token), 'ADM-0001 signed in');

// Enumeration: a real ID and a made-up one must be indistinguishable.
const realAsk = await app.inject({
  method: 'POST', url: '/auth/otp/request', payload: { identifier: 'EMP-0100' } });
const fakeAsk = await app.inject({
  method: 'POST', url: '/auth/otp/request', payload: { identifier: 'EMP-NOBODY' } });
const strip = (b) => { const { devCode, ...rest } = b; return JSON.stringify(rest); };
check(6, 'a real and a made-up identifier answer identically',
  realAsk.statusCode === fakeAsk.statusCode &&
  strip(realAsk.json()) === strip(fakeAsk.json()),
  strip(fakeAsk.json()));

// ── One device at a time, on mobile ──────────────────────────────────────
const firstPhone = await signIn(empRow.phone, { deviceLabel: 'Redmi 12C' });
const stillWorks = await get('/auth/me', firstPhone.token);
check(6, 'the phone that just signed in works',
  stillWorks.statusCode === 200, `status ${stillWorks.statusCode}`);

const secondPhone = await signIn(empRow.phone, { deviceLabel: 'Samsung A14' });
const oldPhone = await get('/auth/me', firstPhone.token);
check(6, 'signing in on a second phone signs the first one out',
  oldPhone.statusCode === 401 && oldPhone.json().error === 'SIGNED_IN_ELSEWHERE',
  `status ${oldPhone.statusCode}, ${oldPhone.json().error}`);

check(6, 'the message names what happened, not just "sign in again"',
  /different phone/i.test(oldPhone.json().message ?? ''),
  JSON.stringify(oldPhone.json().message));

check(6, 'the new phone is told which device it displaced',
  secondPhone.displaced_devices?.[0]?.device_label === 'Redmi 12C',
  JSON.stringify(secondPhone.displaced_devices));

// The displaced phone may still be holding signed, unsent attendance, and
// its key cannot move to the new handset. Hard-revoking would destroy it.
const displacedRow = await col('sessions').findOne({ _id: firstPhone.session_id });
check(6, 'the displaced phone is DRAIN_ONLY, so unsent attendance is not lost',
  displacedRow?.state === 'DRAIN_ONLY' && displacedRow?.reason === 'SIGNED_IN_ELSEWHERE',
  `state ${displacedRow?.state}, reason ${displacedRow?.reason}`);

// ── Signing out is a server-side act ─────────────────────────────────────
const out = await post('/auth/logout', secondPhone.token);
const afterOut = await get('/auth/me', secondPhone.token);
check(6, 'signing out ends the session on the server, not just on the phone',
  out.statusCode === 200 && afterOut.statusCode === 401,
  `logout ${out.statusCode}, reuse ${afterOut.statusCode}`);

// ── The web portal ───────────────────────────────────────────────────────
const seniorOnWeb = await signIn(seniorRow.email, { channel: 'WEB' });
check(6, 'a senior is refused the web portal at the door',
  seniorOnWeb.statusCode === 403 && seniorOnWeb.error === 'WEB_NOT_PERMITTED',
  `status ${seniorOnWeb.statusCode}, ${seniorOnWeb.error}`);

const adminMobile = await signIn('ADM-0001', { channel: 'MOBILE', deviceLabel: 'Pixel 7' });
const adminWeb = await signIn('admin@demo-contractor.example', { channel: 'WEB' });
const adminPhoneAfter = await get('/auth/me', adminMobile.token);
check(6, 'an admin signing in on the web does NOT sign out their phone',
  adminWeb.statusCode !== 403 && Boolean(adminWeb.token) && adminPhoneAfter.statusCode === 200,
  `web ok, phone still ${adminPhoneAfter.statusCode}`);

const adminWeb2 = await signIn('admin@demo-contractor.example', { channel: 'WEB' });
const firstBrowser = await get('/auth/me', adminWeb.token);
check(6, 'a second browser does not sign out the first — two computers is not fraud',
  Boolean(adminWeb2.token) && firstBrowser.statusCode === 200,
  `first browser still ${firstBrowser.statusCode}`);

const deviceList = await get('/auth/sessions', adminWeb2.token);
check(6, 'an admin can see and revoke their own devices',
  deviceList.statusCode === 200 && deviceList.json().sessions.length >= 3 &&
  deviceList.json().sessions.some((x) => x.current === true),
  `${deviceList.json().sessions?.length} sessions listed`);

const revoke = await post(`/auth/sessions/${adminWeb.session_id}/revoke`, adminWeb2.token);
const revoked = await get('/auth/me', adminWeb.token);
check(6, 'revoking a browser takes effect on its very next request',
  revoke.statusCode === 200 && revoked.statusCode === 401,
  `revoke ${revoke.statusCode}, reuse ${revoked.statusCode}`);

// byEmail is EMP-0006, whose session nothing above has displaced.
const otherPersons = await post(`/auth/sessions/${adminWeb2.session_id}/revoke`, byEmail.token);
check(6, "nobody can revoke somebody else's session",
  otherPersons.statusCode === 404, `status ${otherPersons.statusCode}`);

// ── Criterion 7 ──────────────────────────────────────────────────────────
console.log('\n\x1b[1m7. Adding ONE employee by hand — same rules as the import\x1b[0m');

const create = (token, fields) =>
  app.inject({
    method: 'POST', url: '/employees', payload: fields,
    headers: { authorization: `Bearer ${token}` },
  });

const adminWebToken = adminWeb2.token;

const made = await create(adminWebToken, {
  employee_id: 'NEW-0001', name: 'Kavita Devi', phone: '9812345601',
  role: 'EMPLOYEE', reports_to: 'EMP-0006', language: 'hi',
});
check(7, 'a super admin adds one employee',
  made.statusCode === 201 && made.json().employee?.employee_id === 'NEW-0001',
  `status ${made.statusCode}`);

check(7, 'a new employee starts NOT registered — nobody is enrolled by a form',
  made.json().employee?.status === 'ENROLMENT_PENDING',
  `status ${made.json().employee?.status}`);

const attributed = await col('import_batches').countDocuments({
  imported_by: 'ADM-0001', total_rows: 1,
});
check(7, 'who added them is recorded, exactly as an import is', attributed >= 1,
  `${attributed} single-row batches by ADM-0001`);

const dupId = await create(adminWebToken, {
  employee_id: 'NEW-0001', name: 'Someone Else', phone: '9812345602', role: 'EMPLOYEE' });
check(7, 'an existing employee_id is refused, never silently overwritten',
  dupId.statusCode === 409, `status ${dupId.statusCode}`);

const formDupPhone = await create(adminWebToken, {
  employee_id: 'NEW-0002', name: 'X', phone: '9812345601', role: 'EMPLOYEE' });
check(7, 'the form enforces one-number-one-person, naming who holds it',
  formDupPhone.statusCode === 400 &&
  /already belongs to employee "NEW-0001"/.test(formDupPhone.json().message ?? ''),
  formDupPhone.json().message);

const manyProblems = await create(adminWebToken,
  { employee_id: '', name: '', phone: '1', role: '' });
check(7, 'every problem is reported at once, not one per attempt',
  manyProblems.statusCode === 400 && (manyProblems.json().errors ?? []).length >= 4,
  `${(manyProblems.json().errors ?? []).length} errors`);

const noFileTalk = await create(adminWebToken, {
  employee_id: 'NEW-0003', name: 'X', phone: '9812345603',
  role: 'EMPLOYEE', reports_to: 'NOBODY-AT-ALL' });
check(7, 'a form never talks about "this file"',
  noFileTalk.statusCode === 400 && !/file/i.test(noFileTalk.json().message ?? ''),
  noFileTalk.json().message);

const bannedNumberRow = await create(adminWebToken, {
  employee_id: '999999990019', name: 'X', phone: '9812345604', role: 'EMPLOYEE' });
check(7, 'an Aadhaar is refused here too, and never echoed back',
  bannedNumberRow.statusCode === 400 && !JSON.stringify(bannedNumberRow.json()).includes('999999990019'),
  `status ${bannedNumberRow.statusCode}`);

const badRole = await create(adminWebToken, {
  employee_id: 'NEW-0004', name: 'X', phone: '9812345605', role: 'MANAGER' });
check(7, 'a mistyped role is a validation problem, not a permission one',
  badRole.statusCode === 400 && /role must be one of/.test(badRole.json().message ?? ''),
  badRole.json().message);

// Privilege escalation: an ADMIN minting a SUPER_ADMIN would walk straight
// around BR-ROL-5, because they could then sign in as the account they made.
const plainAdmin = await signIn('EMP-0002', { channel: 'WEB' });
const escalate = await create(plainAdmin.token, {
  employee_id: 'NEW-0005', name: 'X', phone: '9812345606', role: 'SUPER_ADMIN' });
check(7, 'an admin cannot create a super admin', escalate.statusCode === 403,
  `status ${escalate.statusCode}, ${escalate.json().message}`);

// A fresh token: criterion 6 signed EMP-0006 in again by email, which
// displaced the session criterion 5 was holding.
const seniorNow = await signIn('EMP-0006');
const seniorTries = await create(seniorNow.token, {
  employee_id: 'NEW-0006', name: 'X', phone: '9812345607', role: 'EMPLOYEE' });
check(7, 'a senior cannot add employees at all', seniorTries.statusCode === 403,
  `status ${seniorTries.statusCode}`);

const newPerson = await signIn('9812345601');
check(7, 'the person just added can sign in with their phone number',
  Boolean(newPerson.token) && newPerson.employee?.employee_id === 'NEW-0001',
  `resolved to ${newPerson.employee?.employee_id}`);

check(7, '…but cannot mark attendance until their face is registered',
  newPerson.employee?.status === 'ENROLMENT_PENDING',
  `status ${newPerson.employee?.status}`);

// ── The OTP door is rate limited ─────────────────────────────────────────
// The gate runs with a raised limit (see package.json) so the functional
// checks above can never trip it by accident. This loop still has to reach
// it, so it tries more times than that raised limit.
let limited = 0;
for (let i = 0; i < 90; i++) {
  const r = await app.inject({
    method: 'POST', url: '/auth/otp/request', payload: { identifier: 'EMP-0100' } });
  if (r.statusCode === 429) { limited = i + 1; break; }
}
check(6, 'the OTP endpoint stops an unauthenticated flood', limited > 0,
  limited ? `429 after ${limited} requests` : 'never rate limited in 90 requests');

// ── Result ───────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.passed).length;
const failed = results.length - passed;

console.log(`\n${'─'.repeat(60)}`);
if (failed === 0) {
  console.log(`\x1b[32m\x1b[1mGATE 1 PASSED\x1b[0m — ${passed}/${results.length} checks`);
  console.log('Criterion 3 (the build guards) is verified separately by npm run guard.');
} else {
  console.log(`\x1b[31m\x1b[1mGATE 1 FAILED\x1b[0m — ${failed} of ${results.length} checks failed`);
  for (const r of results.filter((x) => !x.passed)) {
    console.log(`  ✗ [criterion ${r.criterion}] ${r.description}  — ${r.detail}`);
  }
}
console.log(`${'─'.repeat(60)}\n`);

await app.close();
await closeClient();
process.exit(failed === 0 ? 0 : 1);
