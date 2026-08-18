/**
 * Pramaan — shared vocabulary.
 *
 * ⚠ THIS FILE EXISTS THREE TIMES, BYTE FOR BYTE IDENTICAL:
 *
 *     apps/api/src/lib/vocabulary.js
 *     apps/web/lib/vocabulary.js
 *     apps/mobile/src/vocabulary.js
 *
 * The three apps live in three separate git repositories, so there is no
 * package for them to import from. Three copies are the price of that split.
 * Change one and you MUST copy it over the other two in the same change:
 * `npm run guard` fails if they differ.
 *
 * Everything here is a contract between the three. The phone SENDS these
 * words, the server STORES them, the web app DISPLAYS them — and they are
 * signed into the evidence chain. Two apps disagreeing on a spelling does
 * not crash anything: it produces a record that verifies as authentic and
 * reports the wrong thing. Never redefine one of these words locally.
 *
 * Source of truth: docs/FRD-v1.0.md
 */

// ── Roles ────────────────────────────────────────────────────────────────
// FRD §2.1. Order matters: each role includes everything below it.

export const ROLE = Object.freeze({
  EMPLOYEE: 'EMPLOYEE',
  SENIOR: 'SENIOR',
  ADMIN: 'ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
});

export const ROLES = Object.freeze(Object.values(ROLE));

/** Higher number = more visibility. Never persisted; derived from ROLE. */
const ROLE_RANK = Object.freeze({
  [ROLE.EMPLOYEE]: 0,
  [ROLE.SENIOR]: 1,
  [ROLE.ADMIN]: 2,
  [ROLE.SUPER_ADMIN]: 3,
});

/** True when `role` is at least `required`. */
export function roleAtLeast(role, required) {
  const a = ROLE_RANK[role];
  const b = ROLE_RANK[required];
  if (a === undefined || b === undefined) return false;
  return a >= b;
}

/** Roles allowed to sign in to the web app. FRD BR-WEB-1. */
export const WEB_ROLES = Object.freeze([ROLE.ADMIN, ROLE.SUPER_ADMIN]);

/** Roles that see a team section in the mobile app. FRD BR-ROL-3. */
export const TEAM_ROLES = Object.freeze([ROLE.SENIOR, ROLE.ADMIN, ROLE.SUPER_ADMIN]);

// ── Employee status ──────────────────────────────────────────────────────

export const EMPLOYEE_STATUS = Object.freeze({
  ENROLMENT_PENDING: 'ENROLMENT_PENDING',
  ENROLLED: 'ENROLLED',
  INACTIVE: 'INACTIVE', // deactivated; all records retained. FRD BR-MST-5
});

export const EMPLOYEE_STATUSES = Object.freeze(Object.values(EMPLOYEE_STATUS));

// ── Channels ─────────────────────────────────────────────────────────────
// Both are contracts, not internal labels: the server returns the OTP channel
// to whichever client asked for a code, and the phone SENDS the enrolment
// channel. A client and the server disagreeing on the spelling of either is a
// silent failure, which is the whole reason this file exists.

/** How a one-time code was delivered. Derived from what the user typed. */
export const OTP_CHANNEL = Object.freeze({ SMS: 'SMS', EMAIL: 'EMAIL' });

export const OTP_CHANNELS = Object.freeze(Object.values(OTP_CHANNEL));

/** Where a face template was captured. FRD BR-ENR-2 — never an image. */
export const ENROLMENT_CHANNEL = Object.freeze({ WEB: 'WEB', PHONE: 'PHONE' });

export const ENROLMENT_CHANNELS = Object.freeze(Object.values(ENROLMENT_CHANNEL));

// ── Event types — FROZEN in Phase 2 ──────────────────────────────────────
// FRD §8.4. Adding a type later is permitted. Changing or removing one is
// NOT — it would make every earlier record unverifiable.
//
// Declared here in Phase 1 so the shape is agreed before the events table
// exists. Nothing writes these yet.

export const EVENT_TYPE = Object.freeze({
  DEVICE_BOUND: 'DeviceBound',
  DEVICE_RETIRED: 'DeviceRetired',
  ENROLMENT_NOTICE_ACKNOWLEDGED: 'EnrolmentNoticeAcknowledged',
  ENROLLED: 'Enrolled',
  ENROLMENT_WARNING: 'EnrolmentWarning',
  EMPLOYEES_IMPORTED: 'EmployeesImported',
  SHIFT_CREATED: 'ShiftCreated',
  SHIFT_AMENDED: 'ShiftAmended',
  SHIFT_MEMBERSHIP_CHANGED: 'ShiftMembershipChanged',
  ATTENDANCE_PUNCH: 'AttendancePunch',
  SELF_OVERRIDE: 'SelfOverride',
  SELF_OVERRIDE_RESOLVED: 'SelfOverrideResolved',
  ATTESTATION: 'Attestation',
  PUNCH_RECONCILED: 'PunchReconciled',
  LOCATION_FLAGGED: 'LocationFlagged',
  FLAG_EXPLAINED: 'FlagExplained',
  INTEGRITY_FLAGGED: 'IntegrityFlagged',
  QUARANTINED: 'Quarantined',
  LEAVE_RECORDED: 'LeaveRecorded',
});

export const EVENT_TYPES = Object.freeze(Object.values(EVENT_TYPE));

// ── Attendance ───────────────────────────────────────────────────────────

/**
 * A day is exactly ONE of these. FRD BR-LVE-4.
 * Leave is never merged into present, and never merged into absent.
 */
export const DAY_STATE = Object.freeze({
  VERIFIED: 'VERIFIED',           // face-verified punch
  ATTESTED: 'ATTESTED',           // senior recorded it on their behalf
  LEAVE: 'LEAVE',                 // planned absence — NOT absence
  NOTHING_RECEIVED: 'NOTHING_RECEIVED', // never "did not mark". FRD BR-EXC-3
});

/** What the worker sees. FRD BR-SYN-6. Never collapse these into "done". */
export const SYNC_STATE = Object.freeze({
  SAVED: 'SAVED',         // signed and durable on this device
  SENT: 'SENT',           // delivered to the server
  CONFIRMED: 'CONFIRMED', // server verified signature and chain position
});

/**
 * Recorded separately from the reason. FRD BR-EXC-11/12.
 * ONLY WORKER_FAULT counts toward the three chances.
 */
export const FAULT = Object.freeze({
  WORKER_FAULT: 'WORKER_FAULT',
  DEVICE_FAULT: 'DEVICE_FAULT',
  NETWORK_FAULT: 'NETWORK_FAULT',
  SCHEDULE_NOT_DELIVERED: 'SCHEDULE_NOT_DELIVERED',
  OTHER: 'OTHER',
});

/** The only fault attribution that increments the counter. */
export const COUNTING_FAULT = FAULT.WORKER_FAULT;

export const LEAVE_TYPE = Object.freeze({
  CASUAL: 'CASUAL',
  SICK: 'SICK',
  UNPAID: 'UNPAID',
  WEEKLY_OFF: 'WEEKLY_OFF',
  OTHER: 'OTHER',
});

// ── Work location ────────────────────────────────────────────────────────
// FRD §7. ROUTE is implemented in v1; SITE is in the data model from day one
// so that adding it later needs no change to the evidence record.

export const LOCATION_TYPE = Object.freeze({
  ROUTE: 'ROUTE',
  SITE: 'SITE',
});

// ── Fixed rules ──────────────────────────────────────────────────────────

/** Three punches per shift. Fixed. No other policy exists in v1. FRD BR-SHF-2. */
export const PUNCHES_PER_SHIFT = 3;

/** Escalate this long after a window closes with nothing received. FRD BR-EXC-1. */
export const ESCALATION_DELAY_MINUTES = 60;

/** Failed match attempts before a provisional self-override. FRD BR-ATT-11. */
export const MATCH_ATTEMPTS_BEFORE_OVERRIDE = 3;

/** Enrolment refusal warnings before the system recommends action. FRD BR-ENR-14. */
export const ENROLMENT_WARNINGS_BEFORE_ESCALATION = 3;

/** Attestations attributed to WORKER_FAULT before the admin is told. FRD BR-EXC-14. */
export const CHANCES = 3;

// ── Languages ────────────────────────────────────────────────────────────
// FRD UI-2: shown in native script — हिंदी, not "Hindi".

export const LANGUAGES = Object.freeze([
  { code: 'hi', native: 'हिंदी', english: 'Hindi' },
  { code: 'en', native: 'English', english: 'English' },
]);

export const DEFAULT_LANGUAGE = 'hi';
