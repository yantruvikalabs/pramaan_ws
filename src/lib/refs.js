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
import { col } from '../db/mongo.js';

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
  const existing = await col('subject_refs').findOne({ employee_id: employeeId });
  if (existing) return existing._id;

  const ref = opaque('SUB');
  try {
    // $setOnInsert, never $set: if a concurrent call created the mapping
    // first, this must leave it alone. Overwriting would hand the same person
    // a second reference and split their history across two identities.
    await col('subject_refs').updateOne(
      { employee_id: employeeId },
      { $setOnInsert: { _id: ref, employee_id: employeeId, created_at: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    // An upsert on a unique index is NOT race-free: two concurrent first
    // punches from two devices can both miss the find and both attempt the
    // insert, and one gets E11000. MySQL's ON DUPLICATE KEY UPDATE absorbed
    // this silently. Here the loser must re-read rather than throw — an
    // exception would fail the whole ingest batch for a punch that is fine.
    if (err?.code !== 11000) throw err;
  }

  const row = await col('subject_refs').findOne({ employee_id: employeeId });
  return row._id;
}

/** Who a reference belongs to, or null once erased. */
export async function employeeForSubject(subjectRef) {
  const row = await col('subject_refs').findOne({ _id: subjectRef });
  return row?.employee_id ?? null;
}

/** Resolve many at once — a report joins hundreds of these. */
export async function employeesForSubjects(refs) {
  const unique = [...new Set(refs.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await col('subject_refs').find({ _id: { $in: unique } }).toArray();
  return new Map(rows.map((r) => [r._id, r.employee_id]));
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
  await col('location_fixes').insertOne({
    _id: ref,
    lat: Number(fix.lat),
    lon: Number(fix.lon),
    accuracy_m: fix.accuracy_m === undefined || fix.accuracy_m === null ? null : Number(fix.accuracy_m),
    // A real boolean now, not TINYINT(1)'s 1/0. The schema validator enforces
    // the type, and toLocation() reads it with Boolean() rather than `=== 1`.
    is_mock: Boolean(fix.is_mock),
    created_at: new Date(),
  });
  return ref;
}

/**
 * A stored location row → the shape the rest of the product uses.
 *
 * Exported and pure so it can be tested without a database, because the one
 * line in it that matters cannot be tested any other way.
 *
 * ⚠ `Boolean(r.is_mock)`, never `r.is_mock === 1`.
 *
 * MySQL's TINYINT(1) returns the NUMBER 1. A BSON boolean returns `true`, and
 * `true === 1` is **false** — so the same spoofed fix that reads as mocked
 * today would read as genuine after the store changes, silently, with no
 * error anywhere. FRD §14.6 makes mock-location detection the control against
 * fake GPS, so this single comparison is the whole control.
 *
 * The coordinates go through Number() for the same reason: MySQL's DECIMAL(9,6)
 * arrives as a string, a BSON Double as a number, and both must end up as one.
 */
export function toLocation(r) {
  if (!r) return null;
  return {
    lat: Number(r.lat),
    lon: Number(r.lon),
    accuracy_m: r.accuracy_m === null || r.accuracy_m === undefined ? null : Number(r.accuracy_m),
    is_mock: Boolean(r.is_mock),
  };
}

export async function locationFor(locationRef) {
  if (!locationRef) return null;
  return toLocation(await col('location_fixes').findOne({ _id: locationRef }));
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
  const mapping = await col('subject_refs').findOne({ employee_id: employeeId });
  if (!mapping) return { erased: false, reason: 'NO_MAPPING' };

  const subjectRef = mapping._id;

  // MySQL did this as one correlated subquery. Here it is two round trips,
  // which introduces a partial-failure window: removing the name mapping while
  // leaving the coordinate trail is NOT an erasure — a day's positions
  // identify a person with no name attached.
  //
  // So coordinates go FIRST, and the result is verified by reading back rather
  // than trusted. If any fix survives, the mapping is deliberately left in
  // place: a caller that is told "erased" must be able to rely on it, and a
  // half-erasure that reports success is worse than one that reports failure.
  const refs = await col('events').distinct('location_ref',
    { subject_ref: subjectRef, location_ref: { $ne: null } });

  const expected = refs.length === 0
    ? 0
    : await col('location_fixes').countDocuments({ _id: { $in: refs } });

  if (refs.length > 0) await col('location_fixes').deleteMany({ _id: { $in: refs } });

  const remaining = refs.length === 0
    ? 0
    : await col('location_fixes').countDocuments({ _id: { $in: refs } });

  if (remaining > 0) {
    return {
      erased: false,
      reason: 'LOCATION_FIXES_REMAIN',
      subject_ref: subjectRef,
      location_fixes_remaining: remaining,
    };
  }

  await col('subject_refs').deleteOne({ employee_id: employeeId });

  return { erased: true, subject_ref: subjectRef, location_fixes_removed: expected };
}
