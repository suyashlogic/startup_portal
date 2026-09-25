-- ============================================================================
-- 002_resource_management.sql
-- Resource & Asset Management. Additive + idempotent; drops nothing.
-- Run:  psql -U <user> -d incuportal -f migrations/002_resource_management.sql
-- Requires the btree_gist extension (bundled with PostgreSQL contrib; needs a
-- role allowed to CREATE EXTENSION, or ask your DBA to run it once).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION rm_set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = CURRENT_TIMESTAMP; RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ── 1. CATEGORIES (admin-managed, never hardcoded) ─────────────────────────
CREATE TABLE IF NOT EXISTS resource_categories (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(80) NOT NULL,
    description TEXT,
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_categories_name ON resource_categories (LOWER(name));

INSERT INTO resource_categories (name) VALUES
 ('Electronics'),('Computing'),('Robotics'),('Fabrication'),('Laboratory'),
 ('Photography'),('Audio/Visual'),('Furniture'),('Workspace'),('Meeting Rooms'),
 ('Software/Technical'),('Other')
ON CONFLICT DO NOTHING;

-- ── 2. ASSET CODE COUNTERS (atomic, gap-tolerant code generation) ──────────
CREATE TABLE IF NOT EXISTS resource_code_counters (
    prefix      VARCHAR(6) PRIMARY KEY CHECK (prefix ~ '^[A-Z0-9]{2,6}$'),
    last_number INT        NOT NULL DEFAULT 0
);
-- usage: INSERT INTO resource_code_counters(prefix,last_number) VALUES ($1,1)
--        ON CONFLICT (prefix) DO UPDATE SET last_number = resource_code_counters.last_number + 1
--        RETURNING last_number;

-- ── 3. RESOURCES ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resources (
    id              SERIAL PRIMARY KEY,
    asset_code      VARCHAR(20)  NOT NULL UNIQUE,
    name            VARCHAR(150) NOT NULL,
    category_id     INT          NOT NULL REFERENCES resource_categories(id),
    resource_type   VARCHAR(12)  NOT NULL
                    CHECK (resource_type IN ('ISSUABLE','BOOKABLE','CONSUMABLE','FACILITY')),
    description     TEXT,
    brand           VARCHAR(80),
    model           VARCHAR(80),
    serial_number   VARCHAR(100),
    quantity        INT          NOT NULL DEFAULT 1 CHECK (quantity >= 0),
    unit            VARCHAR(20)  NOT NULL DEFAULT 'unit',
    purchase_date   DATE,
    purchase_cost   NUMERIC(12,2) CHECK (purchase_cost IS NULL OR purchase_cost >= 0),
    warranty_expiry DATE,
    location        VARCHAR(120),
    condition       VARCHAR(14)  NOT NULL DEFAULT 'GOOD'
                    CHECK (condition IN ('NEW','GOOD','FAIR','MINOR_DAMAGE','MAJOR_DAMAGE','UNUSABLE')),
    status          VARCHAR(12)  NOT NULL DEFAULT 'AVAILABLE'
                    CHECK (status IN ('AVAILABLE','RESERVED','ISSUED','IN_USE','MAINTENANCE',
                                      'DAMAGED','RETIRED','UNAVAILABLE')),
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,     -- soft delete; history is never removed
    created_by      INT REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_res_warranty_after_purchase
        CHECK (warranty_expiry IS NULL OR purchase_date IS NULL OR warranty_expiry >= purchase_date),
    CONSTRAINT chk_res_bookable_single
        CHECK (resource_type NOT IN ('BOOKABLE','FACILITY') OR quantity = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_resources_serial ON resources (LOWER(serial_number)) WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_resources_category ON resources (category_id);
CREATE INDEX IF NOT EXISTS idx_resources_status   ON resources (status) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_resources_type     ON resources (resource_type);
CREATE INDEX IF NOT EXISTS idx_resources_warranty ON resources (warranty_expiry) WHERE warranty_expiry IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_resources_search   ON resources (LOWER(name), LOWER(brand), LOWER(model));

-- ── 4. REQUESTS (issuable resources) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_requests (
    id              SERIAL PRIMARY KEY,
    resource_id     INT  NOT NULL REFERENCES resources(id),
    user_id         INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    startup_id      INT  REFERENCES startups(id) ON DELETE SET NULL,
    quantity        INT  NOT NULL DEFAULT 1 CHECK (quantity > 0),
    purpose         TEXT NOT NULL,
    requested_from  DATE NOT NULL,
    requested_until DATE NOT NULL,
    remarks         TEXT,
    status          VARCHAR(10) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED','ISSUED','COMPLETED')),
    reviewed_by     INT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMP,
    admin_remarks   TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_rr_dates CHECK (requested_until >= requested_from),
    CONSTRAINT chk_rr_reject_reason
        CHECK (status <> 'REJECTED' OR (admin_remarks IS NOT NULL AND length(btrim(admin_remarks)) > 0))
);
-- One open PENDING request per (user, resource): blocks duplicate submits.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rr_one_pending ON resource_requests (resource_id, user_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_rr_user    ON resource_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rr_startup ON resource_requests (startup_id);
CREATE INDEX IF NOT EXISTS idx_rr_status  ON resource_requests (status, created_at DESC);

-- ── 5. ASSIGNMENTS (issued equipment) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_assignments (
    id                  SERIAL PRIMARY KEY,
    resource_id         INT  NOT NULL REFERENCES resources(id),
    request_id          INT  UNIQUE REFERENCES resource_requests(id) ON DELETE SET NULL,  -- one issue per request
    user_id             INT  NOT NULL REFERENCES users(id),
    startup_id          INT  REFERENCES startups(id) ON DELETE SET NULL,
    quantity            INT  NOT NULL DEFAULT 1 CHECK (quantity > 0),
    issued_by           INT  REFERENCES users(id) ON DELETE SET NULL,
    issued_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expected_return_at  TIMESTAMP NOT NULL,
    return_requested_at TIMESTAMP,
    returned_at         TIMESTAMP,
    received_by         INT  REFERENCES users(id) ON DELETE SET NULL,
    issue_condition     VARCHAR(14) NOT NULL
                        CHECK (issue_condition IN ('NEW','GOOD','FAIR','MINOR_DAMAGE','MAJOR_DAMAGE')),
    return_condition    VARCHAR(14)
                        CHECK (return_condition IN ('GOOD','FAIR','MINOR_DAMAGE','MAJOR_DAMAGE','LOST')),
    status              VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','RETURN_REQUESTED','RETURNED','OVERDUE','DAMAGED','LOST')),
    remarks             TEXT,
    inspection_notes    TEXT,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_ra_returned CHECK (status NOT IN ('RETURNED','DAMAGED','LOST') OR returned_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_ra_resource ON resource_assignments (resource_id);
CREATE INDEX IF NOT EXISTS idx_ra_user     ON resource_assignments (user_id);
CREATE INDEX IF NOT EXISTS idx_ra_startup  ON resource_assignments (startup_id);
-- "Currently out" lookups, overdue scan and reminder job all use this:
CREATE INDEX IF NOT EXISTS idx_ra_open_due ON resource_assignments (expected_return_at)
    WHERE status IN ('ACTIVE','RETURN_REQUESTED','OVERDUE');

-- ── 6. BOOKINGS (bookable resources) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_bookings (
    id           SERIAL PRIMARY KEY,
    resource_id  INT  NOT NULL REFERENCES resources(id),
    user_id      INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    startup_id   INT  REFERENCES startups(id) ON DELETE SET NULL,
    booking_date DATE NOT NULL,
    start_time   TIME NOT NULL,
    end_time     TIME NOT NULL,
    starts_at    TIMESTAMP GENERATED ALWAYS AS (booking_date + start_time) STORED,
    ends_at      TIMESTAMP GENERATED ALWAYS AS (booking_date + end_time)   STORED,
    purpose      TEXT NOT NULL,
    status       VARCHAR(10) NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED','COMPLETED','NO_SHOW')),
    approved_by  INT REFERENCES users(id) ON DELETE SET NULL,
    approved_at  TIMESTAMP,
    remarks      TEXT,
    admin_remarks TEXT,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_rb_times CHECK (end_time > start_time),
    -- Rule 5: no two APPROVED bookings may overlap on one resource. Enforced by Postgres itself,
    -- so it holds even under concurrent approvals. Violation = SQLSTATE 23P01.
    CONSTRAINT ex_rb_no_resource_overlap
        EXCLUDE USING gist (resource_id WITH =, tsrange(starts_at, ends_at, '[)') WITH &&)
        WHERE (status = 'APPROVED'),
    -- Rule 4: a student cannot hold overlapping live bookings on the same resource.
    CONSTRAINT ex_rb_no_user_overlap
        EXCLUDE USING gist (user_id WITH =, resource_id WITH =, tsrange(starts_at, ends_at, '[)') WITH &&)
        WHERE (status IN ('PENDING','APPROVED'))
);
CREATE INDEX IF NOT EXISTS idx_rb_resource_day ON resource_bookings (resource_id, booking_date);
CREATE INDEX IF NOT EXISTS idx_rb_user         ON resource_bookings (user_id, booking_date DESC);
CREATE INDEX IF NOT EXISTS idx_rb_startup      ON resource_bookings (startup_id);
CREATE INDEX IF NOT EXISTS idx_rb_status       ON resource_bookings (status, booking_date);

-- ── 7. ISSUES (damage / malfunction reports) ────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_issues (
    id            SERIAL PRIMARY KEY,
    resource_id   INT  NOT NULL REFERENCES resources(id),
    reported_by   INT  REFERENCES users(id) ON DELETE SET NULL,
    assignment_id INT  REFERENCES resource_assignments(id) ON DELETE SET NULL,
    issue_type    VARCHAR(14) NOT NULL
                  CHECK (issue_type IN ('DAMAGED','MALFUNCTION','MISSING_PART','LOST','OTHER')),
    description   TEXT NOT NULL,
    attachment    VARCHAR(255),                       -- '/uploads/...' path only
    priority      VARCHAR(8)  NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    status        VARCHAR(16) NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','UNDER_INSPECTION','IN_REPAIR','RESOLVED','CLOSED')),
    assigned_to   INT REFERENCES users(id) ON DELETE SET NULL,
    resolution    TEXT,
    resolved_at   TIMESTAMP,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_ri_resolved CHECK (status NOT IN ('RESOLVED','CLOSED') OR resolved_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_ri_resource ON resource_issues (resource_id);
CREATE INDEX IF NOT EXISTS idx_ri_status   ON resource_issues (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ri_reporter ON resource_issues (reported_by);

-- ── 8. MAINTENANCE ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_maintenance (
    id                  SERIAL PRIMARY KEY,
    resource_id         INT NOT NULL REFERENCES resources(id),
    issue_id            INT REFERENCES resource_issues(id) ON DELETE SET NULL,
    maintenance_type    VARCHAR(12) NOT NULL DEFAULT 'REPAIR'
                        CHECK (maintenance_type IN ('REPAIR','PREVENTIVE','CALIBRATION','UPGRADE','OTHER')),
    description         TEXT,
    vendor              VARCHAR(120),
    technician          VARCHAR(120),
    start_date          DATE NOT NULL DEFAULT CURRENT_DATE,
    expected_completion DATE,
    completion_date     DATE,
    cost                NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
    status              VARCHAR(12) NOT NULL DEFAULT 'SCHEDULED'
                        CHECK (status IN ('SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED')),
    notes               TEXT,
    created_by          INT REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_rm_dates CHECK (expected_completion IS NULL OR expected_completion >= start_date),
    CONSTRAINT chk_rm_done  CHECK (status <> 'COMPLETED' OR completion_date IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_rm_resource ON resource_maintenance (resource_id);
CREATE INDEX IF NOT EXISTS idx_rm_status   ON resource_maintenance (status);
CREATE INDEX IF NOT EXISTS idx_rm_done     ON resource_maintenance (completion_date) WHERE status = 'COMPLETED';

-- ── 9. HISTORY (per-resource timeline; append-only) ─────────────────────────
CREATE TABLE IF NOT EXISTS resource_history (
    id           SERIAL PRIMARY KEY,
    resource_id  INT NOT NULL REFERENCES resources(id),
    event_type   VARCHAR(40) NOT NULL CHECK (event_type ~ '^[A-Z_]+$'),  -- ASSET_ADDED, ISSUED, RETURNED, ...
    from_status  VARCHAR(12),
    to_status    VARCHAR(12),
    actor_id     INT REFERENCES users(id) ON DELETE SET NULL,
    actor_name   VARCHAR(100),                         -- snapshot, survives user deletion
    subject_user_id INT REFERENCES users(id) ON DELETE SET NULL,  -- e.g. who it was issued to
    request_id     INT REFERENCES resource_requests(id)    ON DELETE SET NULL,
    assignment_id  INT REFERENCES resource_assignments(id) ON DELETE SET NULL,
    booking_id     INT REFERENCES resource_bookings(id)    ON DELETE SET NULL,
    issue_id       INT REFERENCES resource_issues(id)      ON DELETE SET NULL,
    maintenance_id INT REFERENCES resource_maintenance(id) ON DELETE SET NULL,
    note         TEXT,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rh_resource ON resource_history (resource_id, created_at DESC, id DESC);

-- ── 10. updated_at triggers ─────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['resource_categories','resources','resource_requests','resource_assignments',
                           'resource_bookings','resource_issues','resource_maintenance']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || t || '_updated') THEN
      EXECUTE format('CREATE TRIGGER trg_%1$s_updated BEFORE UPDATE ON %1$s
                      FOR EACH ROW EXECUTE FUNCTION rm_set_updated_at()', t);
    END IF;
  END LOOP;
END $$;
