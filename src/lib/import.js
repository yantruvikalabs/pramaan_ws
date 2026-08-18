/**
 * Employee master import — FRD FR-MST-001.
 *
 * These people ALREADY work for the contractor. This is an import of an
 * existing payroll list, not hiring and not onboarding.
 *
 * The governing rule is BR-MST-1: import is ROW-LEVEL. Valid rows are
 * created, invalid rows are reported with the reason and the line number,
 * and a bad row never fails the batch. An admin importing 2,000 people
 * cannot be told "something was wrong" and left to find it.
 *
 * Everything here is pure — no database, no I/O. That is deliberate: the
 * validation rules are the part most worth testing, and they should be
 * testable without standing up MySQL.
 */

import { parse } from 'csv-parse/sync';
import { ROLES, ROLE, EMPLOYEE_STATUS, LANGUAGES, DEFAULT_LANGUAGE } from './vocabulary.js';
import { looksLikeAadhaar, findBannedFieldNames } from './aadhaar.js';
import { findCycles, findUnresolvedSeniors } from './tree.js';
import { normalisePhone } from './phone.js';

// Re-exported so the importer keeps one public surface for its callers.
export { normalisePhone };

const REQUIRED_COLUMNS = ['employee_id', 'name', 'phone', 'role'];
// email is optional and always will be. Most of a cleaning or catering
// workforce has no email address; requiring one would exclude them from
// their own attendance. In practice it is the seniors and administrators
// who have one, and it is how they sign in to the web portal.
const KNOWN_COLUMNS = [...REQUIRED_COLUMNS, 'email', 'reports_to', 'language'];
const LANGUAGE_CODES = LANGUAGES.map((l) => l.code);

/** Header names are matched loosely — real CSVs come with spaces and caps. */
function normaliseHeader(name) {
  return String(name).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Deliberately permissive: this is not the place to argue with a valid but
 * unusual address. Stored lowercased so a login always matches.
 */
function normaliseEmail(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value.length === 0) return { ok: true, value: null };
  if (value.length > 255) return { ok: false, value: null };
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)
    ? { ok: true, value }
    : { ok: false, value: null };
}


/**
 * Parse CSV text into normalised row objects.
 * Throws only on a malformed FILE — a malformed row is a row-level result.
 */
export function parseEmployeeCsv(text) {
  const records = parse(text, {
    columns: (header) => header.map(normaliseHeader),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  });

  const headers = records.length > 0 ? Object.keys(records[0]) : [];
  return { headers, records };
}

/**
 * Validate a parsed import.
 *
 * @param {object[]} records  rows from parseEmployeeCsv
 * @param {string[]} headers  normalised column names
 * @param {Set<string>|{ids?: Set<string>, phones?: Map<string,string>, emails?: Map<string,string>}} existing
 *   What is already in the database. A bare Set is read as the employee_ids,
 *   which is all the callers that predate phone uniqueness ever passed.
 *   phones and emails map the value to the employee_id that already holds it,
 *   so a clash can be reported by name instead of as "duplicate".
 * @returns {{fileError: string|null, accepted: object[], rejected: object[], warnings: object[]}}
 */
export function validateImport(records, headers, existing = new Set(), options = {}) {
  // A form has no file. Saying "not in this file" to somebody filling in one
  // person is nonsense, and a message the reader has to translate is a
  // message that failed. FRD UI-4.
  const fromForm = options.source === 'FORM';
  const isBareSet = existing instanceof Set;
  const existingIds = isBareSet ? existing : (existing.ids ?? new Set());
  const existingPhones = isBareSet ? new Map() : (existing.phones ?? new Map());
  const existingEmails = isBareSet ? new Map() : (existing.emails ?? new Map());

  const result = { fileError: null, accepted: [], rejected: [], warnings: [] };

  // ── File-level checks ──────────────────────────────────────────────────
  // A banned COLUMN is a file problem, not a row problem — if the file has
  // an `aadhaar` column, no row in it is safe to accept. FRD BR-MST-9.
  const bannedHeaders = findBannedFieldNames(Object.fromEntries(headers.map((h) => [h, ''])));
  if (bannedHeaders.length > 0) {
    result.fileError =
      `This file has a column named "${bannedHeaders.join('", "')}". ` +
      `Pramaan never stores Aadhaar. Remove the column and upload again.`;
    return result;
  }

  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    result.fileError = `Missing required column(s): ${missing.join(', ')}`;
    return result;
  }

  const unknown = headers.filter((h) => !KNOWN_COLUMNS.includes(h));
  if (unknown.length > 0) {
    result.warnings.push({
      kind: 'UNKNOWN_COLUMNS',
      message: `Ignored column(s): ${unknown.join(', ')}`,
    });
  }

  // ── Row-level checks ───────────────────────────────────────────────────
  const seenIds = new Map();    // employee_id -> first line number
  const seenPhones = new Map(); // phone       -> first line number
  const seenEmails = new Map(); // email       -> first line number

  records.forEach((row, index) => {
    const line = index + 2; // +1 for zero-index, +1 for the header row
    const errors = [];

    const employeeId = String(row.employee_id ?? '').trim();
    const name = String(row.name ?? '').trim();
    const roleRaw = String(row.role ?? '').trim().toUpperCase();
    const reportsTo = String(row.reports_to ?? '').trim();
    const languageRaw = String(row.language ?? '').trim().toLowerCase();

    // Aadhaar in ANY value rejects the row. We report the column name and
    // never the value — echoing it would put an Aadhaar in the log, which
    // is precisely what BR-MST-7 forbids.
    let hasAadhaar = false;
    for (const [key, value] of Object.entries(row)) {
      if (looksLikeAadhaar(value)) {
        hasAadhaar = true;
        errors.push(`Column "${key}" looks like an Aadhaar number. Pramaan never stores Aadhaar.`);
      }
    }

    if (!employeeId) {
      errors.push('employee_id is required');
    } else if (employeeId.length > 64) {
      errors.push('employee_id is longer than 64 characters');
    } else if (seenIds.has(employeeId)) {
      errors.push(`Duplicate employee_id — already used on line ${seenIds.get(employeeId)}`);
    }

    if (!name) errors.push('name is required');
    else if (name.length > 160) errors.push('name is longer than 160 characters');

    // Phone is a login identifier, so one number is one person — an
    // ambiguous identifier is not an identifier. Two people sharing a handset
    // is common on a contract workforce, so this WILL reject real rows; that
    // is the point, and the message says which employee already holds it so
    // the contractor can fix their own list.
    const phone = normalisePhone(row.phone);
    if (!phone) {
      errors.push('phone is not a valid 10-digit Indian mobile number');
    } else if (seenPhones.has(phone)) {
      errors.push(`Duplicate phone number — already used on line ${seenPhones.get(phone)}`);
    } else {
      const holder = existingPhones.get(phone);
      if (holder && holder !== employeeId) {
        errors.push(`Phone number already belongs to employee "${holder}"`);
      }
    }

    const emailResult = normaliseEmail(row.email);
    const email = emailResult.value;
    if (!emailResult.ok) {
      errors.push('email is not a valid email address');
    } else if (email) {
      if (seenEmails.has(email)) {
        errors.push(`Duplicate email — already used on line ${seenEmails.get(email)}`);
      } else {
        const holder = existingEmails.get(email);
        if (holder && holder !== employeeId) {
          errors.push(`Email already belongs to employee "${holder}"`);
        }
      }
    }

    if (!roleRaw) errors.push('role is required');
    else if (!ROLES.includes(roleRaw)) {
      errors.push(`role must be one of: ${ROLES.join(', ')}`);
    }

    if (reportsTo && reportsTo === employeeId) {
      errors.push('reports_to cannot be the employee themselves');
    }

    let language = DEFAULT_LANGUAGE;
    if (languageRaw) {
      if (!LANGUAGE_CODES.includes(languageRaw)) {
        errors.push(`language must be one of: ${LANGUAGE_CODES.join(', ')}`);
      } else {
        language = languageRaw;
      }
    }

    if (errors.length > 0) {
      // When the offending value IS the employee_id, reporting it back would
      // put the Aadhaar into the response, the admin's screen and the import
      // report we persist — the exact leak BR-MST-7 forbids. The line number
      // is enough for an admin to find the row in their own file.
      result.rejected.push({
        line,
        employeeId: hasAadhaar ? null : (employeeId || null),
        errors,
      });
      return;
    }

    seenIds.set(employeeId, line);
    seenPhones.set(phone, line);
    if (email) seenEmails.set(email, line);

    result.accepted.push({
      line,
      employee_id: employeeId,
      name,
      phone,
      email,
      role: roleRaw,
      reports_to: reportsTo || null,
      language,
      status: EMPLOYEE_STATUS.ENROLMENT_PENDING,
    });
  });

  // ── Graph checks, across the whole batch ───────────────────────────────
  // These can only run once every row is known, because reports_to may point
  // at somebody further down the same file.

  const edges = new Map(result.accepted.map((r) => [r.employee_id, r.reports_to]));

  const unresolved = new Set(findUnresolvedSeniors(edges, existingIds));
  if (unresolved.size > 0) {
    moveToRejected(result, (r) => unresolved.has(r.reports_to), (r) =>
      fromForm
        ? `reports_to "${r.reports_to}" is not an employee in the system`
        : `reports_to "${r.reports_to}" does not exist in this file or in the system`);
  }

  // Rebuild after removals — a dangling senior can break a chain that would
  // otherwise have looked like a cycle.
  const edges2 = new Map(result.accepted.map((r) => [r.employee_id, r.reports_to]));
  const cycles = findCycles(edges2);
  if (cycles.length > 0) {
    const inCycle = new Set(cycles.flat());
    const describe = new Map();
    for (const cycle of cycles) {
      const path = [...cycle, cycle[0]].join(' → ');
      for (const id of cycle) describe.set(id, path);
    }
    moveToRejected(result, (r) => inCycle.has(r.employee_id), (r) =>
      `reports_to forms a loop: ${describe.get(r.employee_id)}`);
  }

  result.rejected.sort((a, b) => a.line - b.line);
  return result;
}

/**
 * Validate ONE employee, entered by hand rather than imported.
 *
 * FRD FR-MST-003. Deliberately routed through validateImport rather than
 * given its own rule set: a form and a spreadsheet must never disagree about
 * what a valid employee is. If a duplicate phone is rejected in a CSV it has
 * to be rejected in the form too, with the same words — otherwise an admin
 * learns one set of rules and is contradicted by the other.
 *
 * @param {object} fields   employee_id, name, phone, email, role, reports_to, language
 * @param {object} existing { ids, phones, emails } — see validateImport
 * @returns {{ok: true, employee: object} | {ok: false, errors: string[]}}
 */
export function validateOneEmployee(fields, existing = new Set()) {
  const row = {
    employee_id: fields.employee_id ?? '',
    name: fields.name ?? '',
    phone: fields.phone ?? '',
    email: fields.email ?? '',
    role: fields.role ?? '',
    reports_to: fields.reports_to ?? '',
    language: fields.language ?? '',
  };

  const result = validateImport([row], Object.keys(row), existing, { source: 'FORM' });

  // A file-level problem here can only be a banned column name, which a form
  // cannot produce — but if it ever does, it is still a refusal.
  if (result.fileError) return { ok: false, errors: [result.fileError] };

  if (result.rejected.length > 0) return { ok: false, errors: result.rejected[0].errors };

  // A single row cannot form a loop with itself beyond self-reporting, which
  // validateImport already catches, so an empty accepted list here would be
  // a bug rather than a user error.
  return { ok: true, employee: result.accepted[0] };
}

/** Move accepted rows matching `predicate` into rejected, with a reason. */
function moveToRejected(result, predicate, reasonFor) {
  const keep = [];
  for (const row of result.accepted) {
    if (predicate(row)) {
      result.rejected.push({ line: row.line, employeeId: row.employee_id, errors: [reasonFor(row)] });
    } else {
      keep.push(row);
    }
  }
  result.accepted = keep;
}

/**
 * A row that is valid on its own but changes an existing employee.
 * BR-MST-2: re-importing an existing employee_id UPDATES that employee. It
 * never creates a duplicate and never disturbs their enrolment or records.
 */
export function splitNewAndExisting(accepted, existingIds) {
  const created = [];
  const updated = [];
  for (const row of accepted) {
    (existingIds.has(row.employee_id) ? updated : created).push(row);
  }
  return { created, updated };
}

export { ROLE };
