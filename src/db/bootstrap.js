/**
 * Create the first SUPER_ADMIN.
 *
 * There is a genuine chicken-and-egg here: importing employees requires an
 * ADMIN, and an ADMIN is an employee. Rather than weaken the import endpoint
 * — "allow this when the table is empty" is exactly the kind of exception
 * that becomes a hole — the first account is created by a deployment step
 * run on the server, once.
 *
 *   node src/db/bootstrap.js EMP-0001 "Name" 9876543210
 */

import { query, closePool } from '../db.js';
import { ROLE, EMPLOYEE_STATUS } from '@pramaan/shared';
import { normalisePhone } from '../lib/import.js';
import { looksLikeAadhaar } from '../lib/aadhaar.js';

const [, , employeeId, name, phoneRaw] = process.argv;

if (!employeeId || !name || !phoneRaw) {
  console.error('Usage: node src/db/bootstrap.js <employee_id> <name> <phone>');
  process.exit(1);
}

const phone = normalisePhone(phoneRaw);
if (!phone) {
  console.error('✗ phone is not a valid 10-digit Indian mobile number');
  process.exit(1);
}

// The rule holds here too — a deployment script is not an exception.
if (looksLikeAadhaar(employeeId) || looksLikeAadhaar(name) || looksLikeAadhaar(phoneRaw)) {
  console.error('✗ that value looks like an Aadhaar number. Pramaan never stores Aadhaar.');
  process.exit(1);
}

const existing = await query('SELECT COUNT(*) AS n FROM employees WHERE role = ?', [
  ROLE.SUPER_ADMIN,
]);

if (existing[0].n > 0) {
  console.error('✗ a super admin already exists. Manage further roles in the app.');
  await closePool();
  process.exit(1);
}

await query(
  `INSERT INTO employees (employee_id, name, phone, role, status, language)
   VALUES (?,?,?,?,?,?)`,
  [employeeId, name, phone, ROLE.SUPER_ADMIN, EMPLOYEE_STATUS.ENROLMENT_PENDING, 'hi'],
);

console.log(`✓ super admin created: ${employeeId} (${name})`);
console.log('  Sign in with this employee ID and the OTP sent to that phone.');
await closePool();
