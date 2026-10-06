-- Identity is authoritative in this database. Human and machine IDs never change.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  password_hash TEXT,
  email_verified_at TEXT,
  disabled_at TEXT,
  profile_visibility TEXT NOT NULL DEFAULT 'public' CHECK (profile_visibility IN ('public','private')),
  show_email INTEGER NOT NULL DEFAULT 0 CHECK (show_email IN (0,1)),
  mfa_required INTEGER NOT NULL DEFAULT 0 CHECK (mfa_required IN (0,1)),
  auth_revision INTEGER NOT NULL DEFAULT 1 CHECK (auth_revision > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX users_public_cursor ON users(profile_visibility, id) WHERE disabled_at IS NULL AND email_verified_at IS NOT NULL;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('user','organization')),
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),
  initial_seat_principal_id TEXT REFERENCES users(id),
  description TEXT NOT NULL DEFAULT '',
  disabled_at TEXT,
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK (policy_revision > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (type != 'user' OR owner_user_id IS NOT NULL)
);
CREATE INDEX accounts_owner ON accounts(owner_user_id, id);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user','application','service','agent','runner','job','viewer')),
  user_id TEXT REFERENCES users(id),
  account_id TEXT REFERENCES accounts(id),
  name TEXT NOT NULL,
  disabled_at TEXT,
  expires_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'user' AND user_id = id) OR (kind != 'user' AND user_id IS NULL))
);
CREATE INDEX principals_account_cursor ON principals(account_id, id);

-- The checked statement immediately follows a conditional write in a D1 batch.
-- A failed CHECK rolls back the entire batch, including outbox and audit writes.
CREATE TABLE identity_write_guards (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

CREATE TABLE identity_rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX identity_rate_limits_expiry ON identity_rate_limits(expires_at);
