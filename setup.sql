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

-- NEW: track completed tasks + actual time spent (for personalized estimates)
CREATE TABLE IF NOT EXISTS task_completions (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    task_title    TEXT NOT NULL,
    minutes_spent INTEGER DEFAULT 0,
    completed_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_completions_user_date
    ON task_completions (user_id, completed_at);

-- NEW: calendar notes per user per date
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
