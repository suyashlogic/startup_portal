-- ============================================================================
-- 004_startup_meetings.sql
-- Startup Review & Meeting Scheduling. Additive + idempotent; drops nothing
-- except the one CHECK constraint on startups.status, which is replaced with
-- a wider version that keeps every existing value.
--
-- Requires btree_gist (already enabled by migrations/002 for resource_bookings;
-- CREATE EXTENSION IF NOT EXISTS is safe to repeat).
--
-- Run:  psql -U <user> -d incuportal -f migrations/004_startup_meetings.sql
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION sm_set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = CURRENT_TIMESTAMP; RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ── 0. Widen startups.status ────────────────────────────────────────────────
-- Existing values ('pending','approved','rejected') are untouched — every
-- current row keeps validating. New values slot into the review lifecycle:
--   pending            → SUBMITTED (unchanged meaning)
--   under_review       → an admin has opened it and started reviewing
--   meeting_scheduled  → a review meeting has been booked
--   meeting_completed  → the meeting happened; awaiting the admin's decision
--   changes_requested  → admin asked the student for more information
--   approved / rejected → unchanged
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'startups_status_check'
  ) THEN
    ALTER TABLE startups DROP CONSTRAINT startups_status_check;
  END IF;
END $$;

ALTER TABLE startups ADD CONSTRAINT startups_status_check
  CHECK (status IN ('pending', 'under_review', 'meeting_scheduled',
                     'meeting_completed', 'changes_requested',
                     'approved', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_startups_status ON startups (status) WHERE is_deleted = false;

-- ── 1. STARTUP MEETINGS ─────────────────────────────────────────────────────
-- Founder/student identity is never duplicated here — it's always reached via
-- startup_id → startups.student_id, exactly like every other child table in
-- this schema (progress_updates, mentor_feedback, funding_requests).
CREATE TABLE IF NOT EXISTS startup_meetings (
    id             SERIAL PRIMARY KEY,
    startup_id     INT  NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
    reviewer_id    INT  REFERENCES users(id) ON DELETE SET NULL,   -- assigned admin/reviewer
    created_by     INT  REFERENCES users(id) ON DELETE SET NULL,
    title          VARCHAR(150) NOT NULL DEFAULT 'Startup Review Meeting',
    meeting_date   DATE NOT NULL,
    start_time     TIME NOT NULL,
    end_time       TIME NOT NULL,
    starts_at      TIMESTAMP GENERATED ALWAYS AS (meeting_date + start_time) STORED,
    ends_at        TIMESTAMP GENERATED ALWAYS AS (meeting_date + end_time)   STORED,
    meeting_type   VARCHAR(10) NOT NULL CHECK (meeting_type IN ('IN_PERSON', 'ONLINE', 'HYBRID')),
    location       VARCHAR(255),
    meeting_link   VARCHAR(255),
    agenda         TEXT,
    notes          TEXT,
    status         VARCHAR(24) NOT NULL DEFAULT 'SCHEDULED'
                   CHECK (status IN ('SCHEDULED', 'CONFIRMED', 'RESCHEDULE_REQUESTED',
                                     'COMPLETED', 'CANCELLED', 'NO_SHOW')),
    cancel_reason  TEXT,
    reminder_24h_sent_at TIMESTAMP,     -- idempotency guard for the reminder job
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_sm_times CHECK (end_time > start_time),
    CONSTRAINT chk_sm_location
        CHECK (meeting_type = 'ONLINE'
               OR (location IS NOT NULL AND length(btrim(location)) > 0)),
    CONSTRAINT chk_sm_link
        CHECK (meeting_type = 'IN_PERSON'
               OR (meeting_link IS NOT NULL AND length(btrim(meeting_link)) > 0)),
    CONSTRAINT chk_sm_cancel_reason
        CHECK (status <> 'CANCELLED' OR (cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) > 0)),

    -- Rule 11: the same reviewer cannot have two overlapping live meetings.
    CONSTRAINT ex_sm_no_reviewer_overlap
        EXCLUDE USING gist (reviewer_id WITH =, tsrange(starts_at, ends_at, '[)') WITH &&)
        WHERE (status IN ('SCHEDULED', 'CONFIRMED') AND reviewer_id IS NOT NULL),

    -- Same startup cannot have two overlapping live meetings either.
    CONSTRAINT ex_sm_no_startup_overlap
        EXCLUDE USING gist (startup_id WITH =, tsrange(starts_at, ends_at, '[)') WITH &&)
        WHERE (status IN ('SCHEDULED', 'CONFIRMED'))
);
CREATE INDEX IF NOT EXISTS idx_sm_startup   ON startup_meetings (startup_id, meeting_date DESC);
CREATE INDEX IF NOT EXISTS idx_sm_reviewer  ON startup_meetings (reviewer_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_sm_status    ON startup_meetings (status);
CREATE INDEX IF NOT EXISTS idx_sm_upcoming  ON startup_meetings (starts_at) WHERE status IN ('SCHEDULED', 'CONFIRMED');

DROP TRIGGER IF EXISTS trg_startup_meetings_updated ON startup_meetings;
CREATE TRIGGER trg_startup_meetings_updated BEFORE UPDATE ON startup_meetings
  FOR EACH ROW EXECUTE FUNCTION sm_set_updated_at();

-- ── 2. MEETING OUTCOMES (one per meeting) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS meeting_outcomes (
    id                SERIAL PRIMARY KEY,
    meeting_id        INT UNIQUE NOT NULL REFERENCES startup_meetings(id) ON DELETE CASCADE,
    founder_attended  BOOLEAN NOT NULL DEFAULT false,
    team_attended     BOOLEAN NOT NULL DEFAULT false,
    discussion_notes  TEXT,
    strengths         TEXT,
    concerns          TEXT,
    action_items      TEXT,
    recommendation    VARCHAR(20) CHECK (recommendation IN ('APPROVE', 'REQUEST_CHANGES', 'FOLLOW_UP', 'REJECT')),
    next_review_date  DATE,
    recorded_by       INT REFERENCES users(id) ON DELETE SET NULL,
    recorded_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mo_meeting ON meeting_outcomes (meeting_id);

-- ── 3. RESCHEDULE REQUESTS (student-initiated; admin resolves) ─────────────
CREATE TABLE IF NOT EXISTS meeting_reschedule_requests (
    id             SERIAL PRIMARY KEY,
    meeting_id     INT NOT NULL REFERENCES startup_meetings(id) ON DELETE CASCADE,
    requested_by   INT REFERENCES users(id) ON DELETE SET NULL,
    reason         TEXT NOT NULL,
    status         VARCHAR(10) NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    admin_remarks  TEXT,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at    TIMESTAMP
);
-- Only one open reschedule request per meeting at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mrr_one_pending ON meeting_reschedule_requests (meeting_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_mrr_meeting ON meeting_reschedule_requests (meeting_id, created_at DESC);
