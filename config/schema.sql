CREATE TABLE IF NOT EXISTS users (
    id                   SERIAL PRIMARY KEY,
    name                 VARCHAR(100) NOT NULL,
    email                VARCHAR(150) UNIQUE NOT NULL,
    password_hash        VARCHAR(255),
    role                 VARCHAR(20) CHECK (role IN ('student', 'mentor', 'admin')),
    auth_provider        VARCHAR(20) DEFAULT 'local',   -- 'local' | 'google'
    google_id            VARCHAR(255) UNIQUE,
    is_profile_complete  BOOLEAN DEFAULT false,         -- false until role is chosen
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_local_has_password
        CHECK (auth_provider != 'local' OR password_hash IS NOT NULL),
    CONSTRAINT chk_google_has_id
        CHECK (auth_provider != 'google' OR google_id IS NOT NULL)
);

-- STARTUPS 
CREATE TABLE startups (
    id             SERIAL PRIMARY KEY,
    title          VARCHAR(200) NOT NULL,
    description    TEXT NOT NULL,
    domain         VARCHAR(100) NOT NULL,
    stage          VARCHAR(50) NOT NULL
                   CHECK (stage IN ('idea', 'prototype', 'mvp', 'scaling')),
    pitch_deck_url VARCHAR(255),
    student_id     INT NOT NULL
                   REFERENCES users(id) ON DELETE CASCADE,
    status         VARCHAR(20) DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected')),
    admin_remark   TEXT,
    is_deleted     BOOLEAN DEFAULT FALSE,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (student_id, title)
);

-- MENTOR ASSIGNMENTS 
CREATE TABLE mentor_assignments (
    id          SERIAL PRIMARY KEY,
    startup_id  INT NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
    mentor_id   INT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (startup_id, mentor_id)
);

-- ── 3. PROGRESS UPDATES ──────────────────────────────────────────
CREATE TABLE progress_updates (
    id          SERIAL PRIMARY KEY,
    startup_id  INT NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
    author_id   INT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    description TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── 4. MENTOR FEEDBACK ───────────────────────────────────────────
CREATE TABLE mentor_feedback (
    id          SERIAL PRIMARY KEY,
    startup_id  INT NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
    mentor_id   INT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    feedback    TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── 5. FUNDING REQUESTS ──────────────────────────────────────────
CREATE TABLE funding_requests (
    id               SERIAL PRIMARY KEY,
    startup_id       INT NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
    amount_requested NUMERIC(12, 2) NOT NULL,
    purpose          TEXT NOT NULL,
    proposal_file    VARCHAR(255),
    status           VARCHAR(20) DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected')),
    admin_remark     TEXT,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
