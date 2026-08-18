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

import { connect, col, closeClient } from './mongo.js';
import { ROLE, EMPLOYEE_STATUS } from '../lib/vocabulary.js';
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

await connect();

const existing = await col('employees').countDocuments({ role: ROLE.SUPER_ADMIN });

if (existing > 0) {
  console.error('✗ a super admin already exists. Manage further roles in the app.');
  await closeClient();
  process.exit(1);
}

const now = new Date();
await col('employees').insertOne({
  _id: employeeId,
  name,
  phone,
  email: null,
  role: ROLE.SUPER_ADMIN,
  reports_to: null,
  status: EMPLOYEE_STATUS.ENROLMENT_PENDING,
  language: 'hi',
  created_at: now,
  updated_at: now,
});

console.log(`✓ super admin created: ${employeeId} (${name})`);
console.log('  Sign in with this employee ID and the OTP sent to that phone.');
await closeClient();
