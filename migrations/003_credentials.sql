CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  user_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('session','personal','installation','service','agent','runner','job','viewer')),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  capabilities_json TEXT CHECK (capabilities_json IS NULL OR json_valid(capabilities_json)),
  repository_ids_json TEXT CHECK (repository_ids_json IS NULL OR json_valid(repository_ids_json)),
  account_ids_json TEXT CHECK (account_ids_json IS NULL OR json_valid(account_ids_json)),
  ref_patterns_json TEXT CHECK (ref_patterns_json IS NULL OR json_valid(ref_patterns_json)),
  path_patterns_json TEXT CHECK (path_patterns_json IS NULL OR json_valid(path_patterns_json)),
  parent_id TEXT REFERENCES credentials(id),
  rotation_of_id TEXT REFERENCES credentials(id),
  auth_revision INTEGER,
  mfa INTEGER NOT NULL DEFAULT 0 CHECK (mfa IN (0,1)),
  authenticated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  last_used_ip_hash TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (kind != 'session' OR (user_id IS NOT NULL AND capabilities_json IS NULL AND repository_ids_json IS NULL AND account_ids_json IS NULL)),
  CHECK (kind = 'session' OR capabilities_json IS NOT NULL)
);
CREATE INDEX credentials_owner_cursor ON credentials(created_by, kind, id);
CREATE INDEX credentials_principal ON credentials(principal_id, revoked_at, expires_at);
CREATE INDEX credentials_parent ON credentials(parent_id);
CREATE INDEX credentials_expiry ON credentials(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE identity_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email','recover_password','change_email','login_mfa','passkey_register','passkey_authenticate','reauthenticate')),
  token_hash TEXT UNIQUE,
  key_id TEXT,
  email TEXT COLLATE NOCASE,
  credential_id TEXT REFERENCES credentials(id),
  challenge TEXT,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  auth_revision INTEGER,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX identity_actions_user ON identity_actions(user_id, purpose, created_at);
CREATE INDEX identity_actions_expiry ON identity_actions(expires_at);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL CHECK (counter >= 0),
  transports_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transports_json)),
  device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice','multiDevice')),
  backed_up INTEGER NOT NULL CHECK (backed_up IN (0,1)),
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX passkeys_user_cursor ON passkeys(user_id, id);

-- The authenticator seed is derived using a separately managed authentication
-- key and this random salt. Neither the seed nor a decryptable tenant secret is
-- stored here. Retain referenced key versions when rotating authentication keys.
CREATE TABLE user_mfa (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  salt TEXT NOT NULL,
  key_id TEXT NOT NULL,
  last_counter INTEGER NOT NULL DEFAULT -1,
  enabled_at TEXT,
  setup_expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, code_hash)
);
CREATE INDEX recovery_codes_user ON recovery_codes(user_id, consumed_at);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  homepage_url TEXT,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  disabled_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX applications_account_cursor ON applications(account_id, id);
CREATE TABLE installations (
  id TEXT PRIMARY KEY REFERENCES principals(id),
  application_id TEXT NOT NULL REFERENCES applications(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  repository_ids_json TEXT NOT NULL CHECK (json_valid(repository_ids_json)),
  suspended_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  installed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, application_id)
);
CREATE INDEX installations_account_cursor ON installations(account_id, id);
