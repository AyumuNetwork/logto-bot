/**
 * Schema is applied idempotently on boot (`IF NOT EXISTS`). Every statement is a
 * forward-compatible additive change so an existing database keeps working.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id      INTEGER NOT NULL UNIQUE,
  tg_username     TEXT,
  logto_user_id   TEXT UNIQUE,
  logto_email     TEXT,
  notify_flags    TEXT NOT NULL DEFAULT '{}',
  bind_source     TEXT NOT NULL DEFAULT 'auto',
  notify_blocked  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  bound_at        INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_logto_idx ON users(logto_user_id);

CREATE TABLE IF NOT EXISTS login_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id     INTEGER NOT NULL,
  logto_user_id  TEXT,
  email          TEXT,
  ott_id         TEXT,
  strategy       TEXT NOT NULL,
  url            TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER
);
CREATE INDEX IF NOT EXISTS login_links_tg_idx ON login_links(tg_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bind_codes (
  code_hash   TEXT PRIMARY KEY,
  tg_user_id  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE TABLE IF NOT EXISTS group_members (
  chat_id      INTEGER NOT NULL,
  tg_user_id   INTEGER NOT NULL,
  status       TEXT NOT NULL,
  custom_title TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (chat_id, tg_user_id)
);

CREATE TABLE IF NOT EXISTS role_sync_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      INTEGER NOT NULL,
  tg_user_id   INTEGER NOT NULL,
  logto_user_id TEXT,
  before_roles TEXT NOT NULL,
  after_roles  TEXT NOT NULL,
  reason       TEXT NOT NULL,
  at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logto_events (
  dedupe_key        TEXT PRIMARY KEY,
  hook_id           TEXT,
  event             TEXT NOT NULL,
  created_at_logto  TEXT,
  received_at       INTEGER NOT NULL,
  status            TEXT NOT NULL,
  payload           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logto_events_received_idx ON logto_events(received_at DESC);

CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  method     TEXT NOT NULL DEFAULT 'sendMessage',
  payload    TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(status, next_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_groups (
  chat_id        INTEGER PRIMARY KEY,
  enabled        INTEGER NOT NULL DEFAULT 1,
  remove_on_leave INTEGER NOT NULL DEFAULT 1,
  title          TEXT,
  created_at     INTEGER NOT NULL,
  created_by     INTEGER
);

CREATE TABLE IF NOT EXISTS role_mappings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('status', 'title')),
  key        TEXT NOT NULL,
  role_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  UNIQUE (chat_id, kind, key)
);
CREATE INDEX IF NOT EXISTS role_mappings_chat_idx ON role_mappings(chat_id);

CREATE TABLE IF NOT EXISTS admin_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_tg_id  INTEGER NOT NULL,
  action       TEXT NOT NULL,
  target       TEXT,
  detail       TEXT,
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_at_idx ON admin_audit(at DESC);
`;
