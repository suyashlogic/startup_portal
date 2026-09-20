-- ============================================================================
-- 001_notification_system.sql
-- Additive + idempotent: safe to run more than once, drops nothing.
-- Naming follows the existing schema (`id SERIAL`, TIMESTAMP columns).
-- ============================================================================

-- ── 0. Columns auth.js already relies on but schema.sql never declared ─────
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token        VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expiry TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_users_reset_token
    ON users (reset_token) WHERE reset_token IS NOT NULL;

-- ── 1. IN-APP NOTIFICATIONS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
    id           SERIAL PRIMARY KEY,
    user_id      INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type         VARCHAR(50)  NOT NULL CHECK (type ~ '^[A-Z_]+$'),   -- e.g. STARTUP_APPROVED
    title        VARCHAR(200) NOT NULL,
    message      TEXT         NOT NULL,
    link         VARCHAR(255),                                        -- internal path only
    entity_type  VARCHAR(30),                                         -- startup | funding | feedback | user ...
    entity_id    INT,
    dedupe_key   VARCHAR(200),
    is_read      BOOLEAN      NOT NULL DEFAULT FALSE,
    read_at      TIMESTAMP,
    created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_read_at CHECK (is_read = TRUE OR read_at IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread       ON notifications (user_id) WHERE is_read = FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe
    ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ── 2. EMAIL LOG (no bodies, no tokens: metadata only) ─────────────────────
CREATE TABLE IF NOT EXISTS email_logs (
    id                   SERIAL PRIMARY KEY,
    recipient            VARCHAR(150) NOT NULL,
    subject              VARCHAR(255) NOT NULL,
    template             VARCHAR(60)  NOT NULL,
    category             VARCHAR(30)  NOT NULL,
    status               VARCHAR(10)  NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'sent', 'failed')),
    error_message        TEXT,
    message_id           VARCHAR(255),
    related_user_id      INT REFERENCES users(id) ON DELETE SET NULL,
    related_entity_type  VARCHAR(30),
    related_entity_id    INT,
    dedupe_key           VARCHAR(200),
    sent_at              TIMESTAMP,
    created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_logs_status   ON email_logs (status);
CREATE INDEX IF NOT EXISTS idx_email_logs_created  ON email_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_template ON email_logs (template);
CREATE INDEX IF NOT EXISTS idx_email_logs_entity   ON email_logs (related_entity_type, related_entity_id);
-- A failed attempt does NOT block a later retry with the same key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_logs_dedupe
    ON email_logs (recipient, dedupe_key)
    WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'sent');

-- ── 3. EMAIL PREFERENCES (row per category => new categories need no migration)
-- No row means "enabled" (opt-out model). Mandatory categories are enforced in code.
CREATE TABLE IF NOT EXISTS email_preferences (
    user_id     INT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category    VARCHAR(30) NOT NULL CHECK (category ~ '^[a-z_]+$'),
    enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
    updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, category)
);

-- ── 4. AUDIT TRAIL (who did what to which entity; complements email_logs) ──
CREATE TABLE IF NOT EXISTS audit_logs (
    id           SERIAL PRIMARY KEY,
    actor_id     INT REFERENCES users(id) ON DELETE SET NULL,
    actor_name   VARCHAR(100),                 -- snapshot: survives user deletion
    actor_role   VARCHAR(20),
    action       VARCHAR(50) NOT NULL CHECK (action ~ '^[A-Z_]+$'),
    entity_type  VARCHAR(30),
    entity_id    INT,
    result       VARCHAR(10) NOT NULL DEFAULT 'success' CHECK (result IN ('success', 'failure')),
    details      JSONB,
    ip_address   VARCHAR(64),
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_logs (actor_id);
