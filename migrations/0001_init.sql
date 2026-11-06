CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  gmail_message_id TEXT PRIMARY KEY,
  gmail_thread_id TEXT NOT NULL,
  internal_date INTEGER NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL,
  importance TEXT NOT NULL,
  summary_zh TEXT NOT NULL,
  action_items_json TEXT NOT NULL DEFAULT '[]',
  deadline TEXT,
  suggested_action TEXT NOT NULL DEFAULT '',
  notified_at INTEGER,
  processed_at INTEGER NOT NULL,
  analysis_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emails_internal_date ON emails(internal_date);
CREATE INDEX IF NOT EXISTS idx_emails_importance ON emails(importance, internal_date);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  gmail_message_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_history_id TEXT,
  to_history_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
