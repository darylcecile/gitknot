CREATE TABLE vault_entries (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), repo_id TEXT REFERENCES repositories(id), environment_id TEXT,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('user','organization','repository','environment')), scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('secret','variable')), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)), policy_revision INTEGER NOT NULL DEFAULT 1,
  current_version_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, deleted_at TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(account_id,scope_type,scope_id,kind,name),
  CHECK((scope_type IN ('user','organization') AND repo_id IS NULL AND environment_id IS NULL)
    OR (scope_type='repository' AND repo_id IS NOT NULL AND environment_id IS NULL)
    OR (scope_type='environment' AND repo_id IS NOT NULL AND environment_id IS NOT NULL))
);
CREATE INDEX vault_scope_entries ON vault_entries(account_id,scope_type,scope_id,kind,name);
CREATE INDEX vault_repo_entries ON vault_entries(repo_id,kind,name);
CREATE TABLE vault_ciphertexts (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('tenant_secret','webhook_signing')),
  context_json TEXT NOT NULL CHECK(json_valid(context_json)), iv TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE vault_versions (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES vault_entries(id), account_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0), ciphertext_id TEXT REFERENCES vault_ciphertexts(id), plain_value TEXT,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, UNIQUE(entry_id,version),
  CHECK((ciphertext_id IS NULL) != (plain_value IS NULL))
);
CREATE INDEX vault_versions_entry ON vault_versions(account_id,entry_id,version DESC);
CREATE TABLE vault_version_revocations (
  version_id TEXT PRIMARY KEY REFERENCES vault_versions(id), account_id TEXT NOT NULL, entry_id TEXT NOT NULL,
  revoked_at TEXT NOT NULL, revoked_by TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE vault_key_registry (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('active','decrypt_only','retired')),
  wrap_count INTEGER NOT NULL DEFAULT 0 CHECK(wrap_count>=0 AND wrap_count<=10000000),
  created_at TEXT NOT NULL, activated_at TEXT, last_wrapped_at TEXT, retired_at TEXT, recovery_verified_at TEXT
);
CREATE TABLE vault_key_control (
  id INTEGER PRIMARY KEY CHECK(id=1), active_key_id TEXT NOT NULL REFERENCES vault_key_registry(id),
  revision INTEGER NOT NULL DEFAULT 1, catalog_revision INTEGER NOT NULL DEFAULT 0, write_fenced INTEGER NOT NULL DEFAULT 0 CHECK(write_fenced IN (0,1))
);
CREATE TABLE vault_key_wraps (
  ciphertext_id TEXT NOT NULL REFERENCES vault_ciphertexts(id), key_id TEXT NOT NULL REFERENCES vault_key_registry(id),
  iv TEXT NOT NULL, wrapped_dek TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(ciphertext_id,key_id), UNIQUE(key_id,iv)
);
CREATE INDEX vault_wraps_rotation ON vault_key_wraps(key_id,ciphertext_id);
CREATE TRIGGER vault_wrap_count AFTER INSERT ON vault_key_wraps BEGIN
  UPDATE vault_key_registry SET wrap_count=wrap_count+1,last_wrapped_at=NEW.created_at WHERE id=NEW.key_id;
END;
CREATE TRIGGER vault_cipher_catalog AFTER INSERT ON vault_ciphertexts BEGIN
  UPDATE vault_key_control SET catalog_revision=catalog_revision+1 WHERE id=1;
END;
CREATE TRIGGER vault_ciphertexts_immutable_update BEFORE UPDATE ON vault_ciphertexts BEGIN SELECT RAISE(ABORT,'immutable ciphertext'); END;
CREATE TRIGGER vault_ciphertexts_immutable_delete BEFORE DELETE ON vault_ciphertexts BEGIN SELECT RAISE(ABORT,'immutable ciphertext'); END;
CREATE TRIGGER vault_versions_immutable_update BEFORE UPDATE ON vault_versions BEGIN SELECT RAISE(ABORT,'immutable vault version'); END;
CREATE TRIGGER vault_versions_immutable_delete BEFORE DELETE ON vault_versions BEGIN SELECT RAISE(ABORT,'immutable vault version'); END;
CREATE TRIGGER vault_wraps_immutable_update BEFORE UPDATE ON vault_key_wraps BEGIN SELECT RAISE(ABORT,'immutable key wrap'); END;
CREATE TRIGGER vault_wraps_immutable_delete BEFORE DELETE ON vault_key_wraps BEGIN SELECT RAISE(ABORT,'immutable key wrap'); END;
CREATE TABLE vault_operations (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, principal_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL, response_json TEXT NOT NULL CHECK(json_valid(response_json)), created_at TEXT NOT NULL
);
CREATE TABLE vault_write_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
