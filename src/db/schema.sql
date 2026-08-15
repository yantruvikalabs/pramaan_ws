-- ⚠ SUPERSEDED. The application runs on MongoDB — see src/db/mongo-schema.js.
--
-- Kept deliberately, for two reasons:
--   1. tools/migrate-to-mongo.mjs reads a database built by this file.
--   2. The comments below record WHY each constraint exists, and every one of
--      those reasons still applies. mongo-schema.js says which of them are now
--      enforced by the application rather than by the database — read the two
--      together, not this one alone.
--
-- Pramaan — Phase 1 schema.
--
-- Master data (mutable) plus the Phase 2 evidence chain (append-only).
--
-- O-1 was answered on 2 Aug 2026 (FRD §14.5) and §8 is frozen. Two rules
-- govern everything below the master-data section:
--
--   1. The chain is APPEND-ONLY. No UPDATE, no DELETE, for any role
--      including Super Admin. scripts/guard-append-only.mjs fails the build.
--   2. NO PERSONAL DATA INSIDE THE ENVELOPE — FRD NFR-17. Events carry
--      opaque references; the mappings to a person and to coordinates live
--      in ordinary deletable tables. Erasure after the retention period is
--      a DELETE from those tables and the chain still verifies.
--
-- There is no device_keys table and there will not be one: the SERVER signs
-- (D-12, reversed 2 Aug 2026). Any employee, any phone, one live session.
--
-- Deliberately absent, do not add here:
--   shifts, leave, routes  (Phase 5 and Phase 8)
--
-- Master data below IS mutable. The append-only rule (FRD BR-EVD-12) applies
-- to event tables, which do not exist yet.

SET NAMES utf8mb4;

-- ── Employees ────────────────────────────────────────────────────────────
-- Imported from the contractor's existing payroll list. We do not hire,
-- onboard or recruit. FRD FR-MST-001.
--
-- There is no aadhaar column and there never will be. FRD BR-MST-9 and
-- scripts/guard-aadhaar.mjs fail the build if one appears.

-- phone is UNIQUE: one number is one person. It is a login identifier, and
-- an ambiguous identifier is not an identifier. The importer rejects a
-- duplicate number naming the employee that already holds it.
--
-- email is NULLABLE and UNIQUE. Most of the workforce — cleaners, food
-- handlers, guards — has no email address, so it can never be required.
-- MySQL permits repeated NULLs in a unique index, which is exactly right
-- here. In practice it is the seniors' and administrators' identifier.

CREATE TABLE IF NOT EXISTS employees (
  employee_id   VARCHAR(64)  NOT NULL,
  name          VARCHAR(160) NOT NULL,
  phone         VARCHAR(20)  NOT NULL,
  email         VARCHAR(255) NULL,
  role          ENUM('EMPLOYEE','SENIOR','ADMIN','SUPER_ADMIN') NOT NULL DEFAULT 'EMPLOYEE',
  reports_to    VARCHAR(64)  NULL,
  status        ENUM('ENROLMENT_PENDING','ENROLLED','INACTIVE') NOT NULL DEFAULT 'ENROLMENT_PENDING',
  language      CHAR(2)      NOT NULL DEFAULT 'hi',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (employee_id),
  UNIQUE KEY uq_employees_phone (phone),
  UNIQUE KEY uq_employees_email (email),
  KEY idx_employees_reports_to (reports_to),
  KEY idx_employees_role       (role),
  KEY idx_employees_status     (status),

  -- RESTRICT, not CASCADE: deactivating an employee must never remove
  -- anybody, and nothing in this product deletes a person. FRD BR-MST-5.
  CONSTRAINT fk_employees_reports_to
    FOREIGN KEY (reports_to) REFERENCES employees (employee_id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── One-time passcodes ───────────────────────────────────────────────────
-- Login is phone, email or employee ID, then a one-time code.
-- The code itself is never stored — only a hash of it.
--
-- channel records how it was sent, because the two have different delivery
-- guarantees and an unanswered code is diagnosed differently depending on
-- whether it went to an Indian mobile network or to a mailbox.

CREATE TABLE IF NOT EXISTS otp_codes (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id  VARCHAR(64) NOT NULL,
  code_hash    CHAR(64)    NOT NULL,
  channel      ENUM('SMS','EMAIL') NOT NULL DEFAULT 'SMS',
  expires_at   DATETIME(3) NOT NULL,
  attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  consumed_at  DATETIME(3) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_otp_employee (employee_id, consumed_at),
  KEY idx_otp_expiry   (expires_at),

  CONSTRAINT fk_otp_employee
    FOREIGN KEY (employee_id) REFERENCES employees (employee_id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Sessions ─────────────────────────────────────────────────────────────
-- "Signed in until you sign out" cannot be done with a token's expiry alone,
-- because a token that has been issued cannot be taken back. The token
-- carries a session id and requireAuth checks this table on every request —
-- which it can afford, because it already re-reads the employee anyway.
--
-- MOBILE and WEB deliberately behave differently:
--
--   MOBILE  exactly one live session per person. This is an ANTI-FRAUD
--           control, not a convenience: if an account is live on two
--           phones, a second person can punch as the first, and the whole
--           product claim — that this attendance is provable — collapses.
--           No inactivity expiry; a worker must never be logged out
--           standing at a gate at 6am.
--
--   WEB     several browsers allowed, each listed and separately
--           revocable, and expiring after inactivity. An administrator with
--           a laptop and a desktop is not committing fraud, but a browser
--           left signed in on a shared office machine is a real risk, and
--           this is the account that can see all 2,000 employees.
--
-- state is a STATE, not a boolean, because of DRAIN_ONLY:
--
--   From Phase 2 a replaced phone can still be holding punches captured
--   offline and never uploaded. They exist ONLY in that phone's local
--   store, so hard-revoking that session would silently destroy a day's
--   attendance. A DRAIN_ONLY session may upload punches it already
--   recorded and do nothing else — safe, because the server assigns the
--   sequence and signature itself and deduplicates on event_id.

CREATE TABLE IF NOT EXISTS sessions (
  session_id    CHAR(36)     NOT NULL,
  employee_id   VARCHAR(64)  NOT NULL,
  channel       ENUM('MOBILE','WEB') NOT NULL,
  state         ENUM('ACTIVE','DRAIN_ONLY','REVOKED') NOT NULL DEFAULT 'ACTIVE',

  -- Generated by the client and stored in its own local storage. Never the
  -- IMEI or the Android ID: those are restricted by Play policy and are
  -- personal data we have no reason to hold.
  device_id     VARCHAR(64)  NULL,
  -- Human-readable, for the "you signed in on X" message. e.g. "Redmi 12C".
  device_label  VARCHAR(120) NULL,

  reason        ENUM('SIGNED_OUT','SIGNED_IN_ELSEWHERE','DEACTIVATED','EXPIRED') NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at      DATETIME(3)  NULL,

  PRIMARY KEY (session_id),
  KEY idx_sessions_employee  (employee_id, channel, state),
  KEY idx_sessions_last_seen (last_seen_at),

  CONSTRAINT fk_sessions_employee
    FOREIGN KEY (employee_id) REFERENCES employees (employee_id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Import batches ───────────────────────────────────────────────────────
-- FRD BR-MST-6 requires the import to be a SIGNED EVENT recording who
-- imported, when, how many rows and the file's hash.
--
-- Phase 1 records it in this table. Phase 2 turns it into an
-- EmployeesImported event in the chain. The columns below are already the
-- fields that event needs, so the migration is a copy, not a redesign.

CREATE TABLE IF NOT EXISTS import_batches (
  batch_id     CHAR(36)     NOT NULL,
  imported_by  VARCHAR(64)  NOT NULL,
  file_name    VARCHAR(255) NULL,
  file_sha256  CHAR(64)     NOT NULL,
  total_rows   INT UNSIGNED NOT NULL DEFAULT 0,
  accepted     INT UNSIGNED NOT NULL DEFAULT 0,
  rejected     INT UNSIGNED NOT NULL DEFAULT 0,
  report       JSON         NOT NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (batch_id),
  KEY idx_import_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ═════════════════════════════════════════════════════════════════════════
-- PHASE 2 · THE EVIDENCE CHAIN
-- ═════════════════════════════════════════════════════════════════════════

-- ── Subject references ───────────────────────────────────────────────────
-- FRD NFR-17. The chain never contains an employee_id. It contains an
-- opaque subject_ref, and THIS table is the only thing that says who that
-- is. Deleting a row here makes every event about that person anonymous
-- while leaving the chain intact and verifiable.
--
-- This table is MUTABLE and DELETABLE. That is the entire point of it.

CREATE TABLE IF NOT EXISTS subject_refs (
  subject_ref  CHAR(40)    NOT NULL,   -- "SUB-" + 36 hex
  employee_id  VARCHAR(64) NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (subject_ref),
  UNIQUE KEY uq_subject_employee (employee_id),

  -- No FK to employees: an employee row may be removed long before the
  -- retention period ends, and this mapping must not block that or be
  -- silently cascaded away.
  KEY idx_subject_employee (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Location fixes ───────────────────────────────────────────────────────
-- Also NFR-17. Raw coordinates never enter the chain, because a trail of
-- positions through a day identifies a person even with no name attached.
-- The event carries a location_ref; the coordinates live here and can be
-- deleted independently of the record that a punch happened.
--
-- MUTABLE and DELETABLE, deliberately.

CREATE TABLE IF NOT EXISTS location_fixes (
  location_ref CHAR(40)      NOT NULL,  -- "LOC-" + 36 hex
  lat          DECIMAL(9,6)  NULL,
  lon          DECIMAL(9,6)  NULL,
  accuracy_m   SMALLINT UNSIGNED NULL,
  is_mock      TINYINT(1)    NOT NULL DEFAULT 0,
  created_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (location_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The chain ────────────────────────────────────────────────────────────
-- ⚠ APPEND-ONLY. FRD BR-EVD-15. There is no UPDATE and no DELETE against
-- this table anywhere in the product, for any role. Corrections are new
-- events that supersede earlier ones, and both remain.
--
-- ONE chain for the whole tenant, not one per device (BR-EVD-7). With
-- per-device chains you could delete a device's entire history and every
-- remaining chain would still verify. With one chain, removing anything
-- breaks it visibly at that point.
--
-- `seq` is assigned by the server under a row lock on chain_head, never by
-- a client, and never by AUTO_INCREMENT — a rolled-back transaction burns
-- an auto-increment value and would leave a gap the verifier reads as
-- tampering.

CREATE TABLE IF NOT EXISTS events (
  seq          BIGINT UNSIGNED NOT NULL,
  event_id     CHAR(36)     NOT NULL,   -- client-generated, the idempotency key
  type         VARCHAR(48)  NOT NULL,
  subject_ref  CHAR(40)     NULL,       -- opaque. NEVER employee_id
  device_ref   VARCHAR(64)  NULL,
  session_ref  CHAR(36)     NULL,
  location_ref CHAR(40)     NULL,       -- opaque. NEVER coordinates
  payload      JSON         NOT NULL,

  captured_at  DATETIME(3)  NULL,       -- when the phone recorded it
  received_at  DATETIME(3)  NOT NULL,   -- when the server accepted it
  device_time  VARCHAR(40)  NULL,       -- as the phone reported it, verbatim
  uptime_ms    BIGINT UNSIGNED NULL,    -- monotonic; a clock can be set back

  canon_v      SMALLINT UNSIGNED NOT NULL,  -- canonical-form version
  prev_hash    CHAR(71)     NOT NULL,   -- "sha256:" + 64 hex
  hash         CHAR(71)     NOT NULL,
  signature    TEXT         NOT NULL,

  PRIMARY KEY (seq),
  UNIQUE KEY uq_events_event_id (event_id),   -- idempotent re-send
  UNIQUE KEY uq_events_hash (hash),
  KEY idx_events_subject (subject_ref, seq),
  KEY idx_events_type (type, seq),
  KEY idx_events_received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Chain head ───────────────────────────────────────────────────────────
-- Exactly one row. Locked FOR UPDATE while appending, which is what makes
-- seq gapless and prev_hash correct under concurrent ingest.
--
-- This row IS updated — it is a pointer, not a record. The guard's
-- append-only rule is about `events`.

CREATE TABLE IF NOT EXISTS chain_head (
  id         TINYINT UNSIGNED NOT NULL DEFAULT 1,
  seq        BIGINT UNSIGNED  NOT NULL DEFAULT 0,
  hash       CHAR(71)         NOT NULL DEFAULT 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  updated_at DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  CONSTRAINT ck_chain_head_single CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO chain_head (id) VALUES (1);

-- ── Published heads ──────────────────────────────────────────────────────
-- FRD BR-EVD-21, and the reason server-side signing means anything.
--
-- Signing protects the chain against everyone EXCEPT whoever runs the
-- server — which is us. A head handed to the contractor before anybody
-- would want to rewrite history is what closes that hole: an altered chain
-- no longer matches a head already in their hands.
--
-- Rows here are a log of what was published, when, and to whom.

CREATE TABLE IF NOT EXISTS published_heads (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  seq          BIGINT UNSIGNED NOT NULL,
  hash         CHAR(71)     NOT NULL,
  signature    TEXT         NOT NULL,
  published_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  destination  VARCHAR(120) NOT NULL,   -- where it went

  PRIMARY KEY (id),
  KEY idx_published_seq (seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Quarantine ───────────────────────────────────────────────────────────
-- FRD BR-EVD-20. A submission that cannot be appended is kept here with the
-- reason, and an alert is raised. Never silently dropped, never silently
-- accepted — the two failure modes that would each destroy trust in the
-- record for opposite reasons.

CREATE TABLE IF NOT EXISTS quarantine (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id     CHAR(36)     NULL,
  reason       VARCHAR(64)  NOT NULL,
  detail       TEXT         NULL,
  submission   JSON         NOT NULL,
  session_ref  CHAR(36)     NULL,
  received_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reviewed_at  DATETIME(3)  NULL,

  PRIMARY KEY (id),
  KEY idx_quarantine_reason (reason, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────
-- face_templates — the enrolled face, as embeddings. FRD §5, FR-ENR-001.
--
-- ⚠ NO IMAGE IS EVER STORED HERE OR ANYWHERE ELSE. BR-ENR-2. A capture is
-- decoded in memory, turned into an embedding, and discarded. There is no
-- column for an image and there must never be one.
--
-- ⚠ THREE ROWS PER EMPLOYEE, NEVER AVERAGED. BR-ENR-1: matching takes the best
-- of the three. Averaging blurs across lighting conditions and degrades every
-- subsequent match, which is why this is three rows rather than one column.
--
-- ⚠ `model` IS PART OF THE IDENTITY, not metadata. An embedding from one model
-- compared against another is meaningless, and O-3 has not yet chosen the
-- recogniser. Storing the model name next to every embedding is what stops a
-- silent cross-model comparison after the choice changes.
--
-- DELETABLE, on purpose. Unlike `events`, this table is ordinary mutable data:
-- it holds biometric material, so erasure after the retention period must be a
-- plain DELETE (NFR-17, §14.5). Nothing in the chain depends on these rows —
-- the Enrolled event records that enrolment happened, not the template itself.
CREATE TABLE IF NOT EXISTS face_templates (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id   VARCHAR(64)  NOT NULL,
  capture_index TINYINT UNSIGNED NOT NULL,   -- 1..3, the varied captures
  model         VARCHAR(96)  NOT NULL,
  dimensions    SMALLINT UNSIGNED NOT NULL,
  -- Little-endian float64 vector. BLOB rather than JSON: it is compared
  -- numerically and never queried by content, and JSON would cost a parse on
  -- every match.
  embedding     BLOB         NOT NULL,
  -- How the capture was taken. Both channels are legitimate (BR-MST-19) and a
  -- later question of "how was this person enrolled?" must be answerable.
  channel       ENUM('WEB','PHONE') NOT NULL,
  enrolled_by   VARCHAR(64)  NOT NULL,       -- BR-ENR-11: who did it
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  -- ── How the capture looked, kept so it can be correlated with match quality.
  --
  -- The first real enrolment was backlit and gave a genuine match score of 0.41.
  -- A re-enrolment in good light gave 0.65-0.72 for the same face. The check had
  -- said so at capture time and the numbers were then discarded — so the link
  -- between "how the capture looked" and "how well this person matches" could not
  -- be tracked, and O-4 is precisely a question about that link.
  --
  -- It also answers what a controller with 2,000 workers actually needs: **who
  -- is likely to fail at the gate, before they do.** A weak template set is
  -- otherwise invisible until somebody is turned away at dawn without pay.
  --
  -- ⚠ NOT AN IMAGE and not reversible into one — four scalars describing the
  -- capture. Nothing here can reconstruct a face.
  face_px         SMALLINT UNSIGNED NULL,
  face_brightness DECIMAL(5,1)  NULL,
  sharpness       DECIMAL(8,1)  NULL,
  off_centre      DECIMAL(4,3)  NULL,
  detector_score  DECIMAL(5,4)  NULL,
  -- What the check advised AT THE TIME. Recorded rather than recomputed: the
  -- thresholds are provisional and will change, and what matters is what the
  -- operator was told when they accepted the capture.
  advised_issues  VARCHAR(255)  NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_template_capture (employee_id, capture_index),
  KEY idx_template_employee (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

