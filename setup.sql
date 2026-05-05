-- Run this in your Supabase SQL Editor (one time only)
-- Dashboard → SQL Editor → New query → paste → Run

CREATE TABLE IF NOT EXISTS user_profiles (
    id             TEXT PRIMARY KEY,
    total_capital  INTEGER DEFAULT 0,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS focus_sessions (
    id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    minutes    INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_date
    ON focus_sessions (user_id, created_at);

-- Track completed tasks + actual time spent (for personalized estimates)
CREATE TABLE IF NOT EXISTS task_completions (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    task_title    TEXT NOT NULL,
    minutes_spent INTEGER DEFAULT 0,
    completed_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_completions_user_date
    ON task_completions (user_id, completed_at);

-- Calendar notes per user per date
CREATE TABLE IF NOT EXISTS calendar_notes (
    id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    date       DATE NOT NULL,
    content    TEXT DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_calendar_notes_user
    ON calendar_notes (user_id, date);

-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATIONS: run these after the initial setup if the table already exists
-- ─────────────────────────────────────────────────────────────────────────────

-- Pro / subscription columns
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS is_pro BOOLEAN DEFAULT FALSE;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'free';
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS subscription_current_period_end BIGINT;

-- Custom timer durations (Pro feature)
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS timer_work  INTEGER;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS timer_short INTEGER;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS timer_long  INTEGER;

-- Index for Stripe customer lookups
CREATE INDEX IF NOT EXISTS idx_user_profiles_stripe_customer
    ON user_profiles (stripe_customer_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Tasks (server-side storage for cross-device persistence)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tasks (
    id             TEXT        NOT NULL,
    user_id        TEXT        NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    title          TEXT        NOT NULL,
    done           BOOLEAN     NOT NULL DEFAULT FALSE,
    estimated_mins INTEGER,
    actual_mins    INTEGER     NOT NULL DEFAULT 0,
    position       INTEGER     NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_position
    ON tasks (user_id, position);

-- ─────────────────────────────────────────────────────────────────────────────
-- Timer state persistence (server-side, one row per user)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS timer_state (
    user_id       TEXT PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,
    mode          TEXT NOT NULL DEFAULT 'focus',
    status        TEXT NOT NULL DEFAULT 'idle',
    duration_secs INTEGER NOT NULL DEFAULT 0,
    started_at    BIGINT,
    elapsed_secs  INTEGER NOT NULL DEFAULT 0,
    wasted_at     BIGINT,
    updated_at    BIGINT NOT NULL DEFAULT 0
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Chat message history (Pro feature)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_messages (
    id         BIGSERIAL PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_user_date
    ON chat_messages (user_id, created_at);
