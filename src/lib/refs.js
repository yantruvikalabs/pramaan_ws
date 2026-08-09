/**
 * Opaque references — FRD NFR-17, NFR-18.
 *
 * The chain never contains an employee_id and never contains coordinates.
 * It contains `subject_ref` and `location_ref`, and THESE tables are the
 * only things that say what they mean.
 *
 * Both are ordinary, mutable, deletable tables. That is the entire point:
 * after the retention period, honouring an erasure request is one DELETE
 * here. Every event about that person survives, still verifies, and simply
 * no longer says who it was about.
 *
 * The consequence, which is intended and not a defect: an evidence pack must
 * be generated while the mapping still exists. Once deleted, packs already
 * issued stay readable but no new one can name that person.
 */

import { randomUUID } from 'node:crypto';
import { query } from '../db.js';

const opaque = (prefix) => `${prefix}-${randomUUID().replace(/-/g, '')}`;

/**
 * The reference for an employee, created once and stable thereafter.
 *
 * Stable rather than per-event on purpose: a fresh reference each time would
 * make the chain unlinkable even to its rightful owner, and reconstructing
 * one person's month would become impossible. The privacy property we want
 * is "meaningless without the mapping", not "meaningless to everybody".
 */
export async function subjectRefFor(employeeId) {
  const rows = await query(
    'SELECT subject_ref FROM subject_refs WHERE employee_id = ?',
    [employeeId],
  );
  if (rows[0]) return rows[0].subject_ref;

  const ref = opaque('SUB');
  // A concurrent first-punch from two devices would otherwise create two.
  await query(
    'INSERT INTO subject_refs (subject_ref, employee_id) VALUES (?,?) ' +
    'ON DUPLICATE KEY UPDATE subject_ref = subject_ref',
    [ref, employeeId],
  );
  const [row] = await query(
    'SELECT subject_ref FROM subject_refs WHERE employee_id = ?',
    [employeeId],
  );
  return row.subject_ref;
}

/** Who a reference belongs to, or null once erased. */
export async function employeeForSubject(subjectRef) {
  const rows = await query(
    'SELECT employee_id FROM subject_refs WHERE subject_ref = ?',
    [subjectRef],
  );
  return rows[0]?.employee_id ?? null;
}

/** Resolve many at once — a report joins hundreds of these. */
export async function employeesForSubjects(refs) {
  const unique = [...new Set(refs.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await query(
    `SELECT subject_ref, employee_id FROM subject_refs
      WHERE subject_ref IN (${unique.map(() => '?').join(',')})`,
    unique,
  );
  return new Map(rows.map((r) => [r.subject_ref, r.employee_id]));
}

/**
 * Store a position and return its reference.
 *
 * A new row per fix, not deduplicated: two people standing in the same place
 * must not share a reference, or deleting one person's data would delete the
 * other's. Cheap rows are the right trade here.
 */
export async function locationRefFor(fix) {
  if (!fix || fix.lat === undefined || fix.lon === undefined) return null;

  const ref = opaque('LOC');
  await query(
    `INSERT INTO location_fixes (location_ref, lat, lon, accuracy_m, is_mock)
     VALUES (?,?,?,?,?)`,
    [ref, fix.lat, fix.lon, fix.accuracy_m ?? null, fix.is_mock ? 1 : 0],
  );
  return ref;
}

export async function locationFor(locationRef) {
  if (!locationRef) return null;
  const rows = await query(
    'SELECT lat, lon, accuracy_m, is_mock FROM location_fixes WHERE location_ref = ?',
    [locationRef],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    lat: Number(r.lat),
    lon: Number(r.lon),
    accuracy_m: r.accuracy_m === null ? null : Number(r.accuracy_m),
    is_mock: r.is_mock === 1,
  };
}

/**
 * Erasure. NFR-15, NFR-16.
 *
 * Removes the mappings and NOTHING in the chain. Afterwards every event
 * about this person still exists, still verifies, and is no longer
 * attributable to them.
 *
 * Deliberately NOT exposed as an API endpoint. Erasure is answered by the
 * contractor (NFR-10) and is only lawful once the statutory retention period
 * has expired (NFR-14) — neither of which this function can know. It is
 * called by an operator, from a script, on a decision already taken.
 */
export async function eraseSubject(employeeId) {
  const rows = await query(
    'SELECT subject_ref FROM subject_refs WHERE employee_id = ?',
    [employeeId],
  );
  if (rows.length === 0) return { erased: false, reason: 'NO_MAPPING' };

  const subjectRef = rows[0].subject_ref;

  // Coordinates first: they identify a person on their own, so a partial
  // erasure that removed the name and left the trail would be no erasure.
  const [{ n: fixes }] = await query(
    `SELECT COUNT(*) AS n FROM location_fixes
      WHERE location_ref IN (SELECT location_ref FROM events
                              WHERE subject_ref = ? AND location_ref IS NOT NULL)`,
    [subjectRef],
  );
  await query(
    `DELETE FROM location_fixes
      WHERE location_ref IN (SELECT location_ref FROM events
                              WHERE subject_ref = ? AND location_ref IS NOT NULL)`,
    [subjectRef],
  );
  await query('DELETE FROM subject_refs WHERE employee_id = ?', [employeeId]);

  return { erased: true, subject_ref: subjectRef, location_fixes_removed: Number(fixes) };
}
