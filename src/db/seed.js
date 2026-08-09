/**
 * Generate a realistic import file for Gate 1.
 *
 *   node src/db/seed.js               -> 2000 clean rows
 *   node src/db/seed.js --dirty       -> 2000 rows with every failure mode
 *
 * Writes to apps/api/fixtures/. Nothing here touches the database — Gate 1
 * requires the file to go through the real import endpoint, not a shortcut.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', '..', 'fixtures');

const FIRST = ['Ramesh', 'Suresh', 'Anil', 'Mohan', 'Vikas', 'Rakesh', 'Dinesh', 'Manoj',
  'Sunita', 'Kavita', 'Rekha', 'Pooja', 'Amit', 'Sanjay', 'Deepak', 'Rajesh'];
const LAST = ['Kumar', 'Yadav', 'Sharma', 'Singh', 'Verma', 'Gupta', 'Lal', 'Prasad',
  'Devi', 'Mishra', 'Pandey', 'Tiwari'];

function name(i) {
  return `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
}

function phone(i) {
  // 6–9 start, 10 digits, deterministic and unique per row.
  const base = 6000000000 + (i * 7919) % 3999999999;
  return String(base);
}

/**
 * A valid Aadhaar-shaped number, for the rejection test ONLY.
 * Generated, never a real number — it satisfies Verhoeff so that the guard
 * has something genuine to catch.
 */
function aadhaarShaped(seed) {
  const D = [
    [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
    [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
    [9,8,7,6,5,4,3,2,1,0],
  ];
  const P = [
    [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
    [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
  ];
  const INV = [0,4,3,2,1,5,6,7,8,9];

  // 11 body digits, first must be 2–9.
  let body = String(2 + (seed % 8));
  for (let i = 1; i < 11; i++) body += String((seed * (i + 3)) % 10);

  let c = 0;
  const rev = body.split('').reverse();
  for (let i = 0; i < rev.length; i++) c = D[c][P[(i + 1) % 8][Number(rev[i])]];
  return body + String(INV[c]);
}

/**
 * Only seniors and administrators get an email address, which is how a real
 * contractor's list looks: the people in the office have one, the people
 * cleaning a coach do not. Login must work for both.
 */
function email(id, role) {
  if (role === 'EMPLOYEE') return '';
  return `${id.toLowerCase()}@demo-contractor.example`;
}

function buildRows({ dirty }) {
  const header = 'employee_id,name,phone,email,role,reports_to,language';
  const rows = [];
  const row = (id, nm, ph, role, reportsTo, lang, mail = email(id, role)) =>
    `${id},${nm},${ph},${mail},${role},${reportsTo},${lang}`;

  // 1 super admin, 4 admins, 80 seniors, rest employees.
  rows.push(row('EMP-0001', name(0), phone(0), 'SUPER_ADMIN', '', 'hi'));
  for (let i = 2; i <= 5; i++) {
    const id = `EMP-${String(i).padStart(4, '0')}`;
    rows.push(row(id, name(i), phone(i), 'ADMIN', 'EMP-0001', 'hi'));
  }
  for (let i = 6; i <= 85; i++) {
    const id = `EMP-${String(i).padStart(4, '0')}`;
    const admin = `EMP-${String(2 + (i % 4)).padStart(4, '0')}`;
    rows.push(row(id, name(i), phone(i), 'SENIOR', admin, 'hi'));
  }
  for (let i = 86; i <= 2000; i++) {
    const id = `EMP-${String(i).padStart(4, '0')}`;
    const senior = `EMP-${String(6 + (i % 80)).padStart(4, '0')}`;
    rows.push(row(id, name(i), phone(i), 'EMPLOYEE', senior, i % 3 === 0 ? 'en' : 'hi'));
  }

  if (!dirty) return [header, ...rows].join('\n') + '\n';

  // Every failure mode the import must report by line number, with a reason.
  //
  // Phone numbers here are drawn from a range the 2,000 clean rows never
  // use, so each bad row fails for exactly the ONE reason it is testing.
  // Otherwise every one of them would also collide on phone and the fixture
  // would stop being able to distinguish the failure modes.
  const p = (i) => phone(9000 + i);

  rows.push(row('EMP-9001', name(1), p(1), 'EMPLOYEE', 'EMP-0006', 'hi'));       // fine
  rows.push(row('', 'Missing Id', p(2), 'EMPLOYEE', 'EMP-0006', 'hi'));          // no employee_id
  rows.push(row('EMP-9003', '', p(3), 'EMPLOYEE', 'EMP-0006', 'hi'));            // no name
  rows.push(row('EMP-9004', name(4), '12345', 'EMPLOYEE', 'EMP-0006', 'hi'));    // bad phone
  rows.push(row('EMP-9005', name(5), p(5), 'MANAGER', 'EMP-0006', 'hi'));        // bad role
  rows.push(row('EMP-9006', name(6), p(6), 'EMPLOYEE', 'EMP-DOES-NOT-EXIST', 'hi')); // dangling
  rows.push(row('EMP-9001', name(7), p(7), 'EMPLOYEE', 'EMP-0006', 'hi'));       // duplicate id
  rows.push(row('EMP-9008', name(8), p(8), 'EMPLOYEE', 'EMP-9008', 'hi'));       // self-reporting
  rows.push(row('EMP-9009', name(9), p(9), 'EMPLOYEE', 'EMP-0006', 'fr'));       // bad language

  // One number, one person. Two people sharing a handset is common on a
  // contract workforce and the importer must say so rather than guess.
  rows.push(row('EMP-9020', name(20), p(1), 'EMPLOYEE', 'EMP-0006', 'hi'));      // phone of EMP-9001

  // Email is optional, but if present it must be valid and unique.
  rows.push(row('EMP-9021', name(21), p(21), 'SENIOR', 'EMP-0006', 'hi', 'not-an-email'));
  rows.push(row('EMP-9022', name(22), p(22), 'SENIOR', 'EMP-0006', 'hi',
    'emp-0006@demo-contractor.example'));                                        // email of EMP-0006

  // A three-node loop: 9010 → 9011 → 9012 → 9010. All three must be rejected.
  rows.push(row('EMP-9010', name(10), p(10), 'SENIOR', 'EMP-9011', 'hi'));
  rows.push(row('EMP-9011', name(11), p(11), 'SENIOR', 'EMP-9012', 'hi'));
  rows.push(row('EMP-9012', name(12), p(12), 'SENIOR', 'EMP-9010', 'hi'));

  // Aadhaar in a value — Gate 1 criterion 2. Rejected, never stored.
  rows.push(row(aadhaarShaped(37), name(13), p(13), 'EMPLOYEE', 'EMP-0006', 'hi', ''));
  rows.push(row('EMP-9014', aadhaarShaped(91), p(14), 'EMPLOYEE', 'EMP-0006', 'hi'));

  return [header, ...rows].join('\n') + '\n';
}

async function main() {
  const dirty = process.argv.includes('--dirty');
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, dirty ? 'employees-2000-dirty.csv' : 'employees-2000.csv');
  await writeFile(file, buildRows({ dirty }), 'utf8');
  const lines = buildRows({ dirty }).trim().split('\n').length - 1;
  console.log(`✓ wrote ${lines} rows -> ${file}`);
}

main().catch((err) => {
  console.error('✗ seed failed:', err.message);
  process.exit(1);
});
