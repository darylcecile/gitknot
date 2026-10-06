-- Federation owns these tables. Core identity tables and credential formats remain authoritative.
CREATE TABLE federation_providers (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('oidc','saml')),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (account_id,id)
);
CREATE INDEX federation_providers_account ON federation_providers(account_id,id) WHERE deleted_at IS NULL;

CREATE TABLE federation_org_policies (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE federation_auth_flows (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_revision INTEGER NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('oidc','saml')),
  state_hash TEXT NOT NULL UNIQUE,
  browser_hash TEXT NOT NULL,
  nonce_hash TEXT,
  pkce_verifier TEXT,
  saml_request_id TEXT UNIQUE,
  return_path TEXT NOT NULL,
  link_user_id TEXT REFERENCES users(id),
  link_credential_id TEXT REFERENCES credentials(id),
  link_auth_revision INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  exchange_started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (account_id,provider_id) REFERENCES federation_providers(account_id,id),
  CHECK ((link_user_id IS NULL AND link_credential_id IS NULL AND link_auth_revision IS NULL)
    OR (link_user_id IS NOT NULL AND link_credential_id IS NOT NULL AND link_auth_revision IS NOT NULL)),
  UNIQUE (account_id,provider_id,id)
);
CREATE INDEX federation_flows_expiry ON federation_auth_flows(expires_at);
CREATE INDEX federation_flows_provider ON federation_auth_flows(account_id,provider_id,provider_revision);

CREATE TABLE federation_replays (
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('oidc_token','saml_assertion','saml_response')),
  nonce_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (account_id,provider_id,kind,nonce_hash),
  FOREIGN KEY (account_id,provider_id) REFERENCES federation_providers(account_id,id)
);
CREATE INDEX federation_replays_expiry ON federation_replays(expires_at);

CREATE TABLE federation_scim_users (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  external_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_name_key TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  attributes_json TEXT NOT NULL CHECK (json_valid(attributes_json)),
  search_json TEXT NOT NULL CHECK (json_valid(search_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (account_id,provider_id) REFERENCES federation_providers(account_id,id),
  UNIQUE (account_id,provider_id,id),
  UNIQUE (account_id,provider_id,external_id),
  UNIQUE (account_id,provider_id,user_id)
);
CREATE UNIQUE INDEX federation_scim_user_names ON federation_scim_users(account_id,provider_id,user_name_key) WHERE deleted_at IS NULL;
CREATE INDEX federation_scim_users_cursor ON federation_scim_users(account_id,provider_id,id) WHERE deleted_at IS NULL;
CREATE INDEX federation_scim_users_principal ON federation_scim_users(user_id,account_id,active);

CREATE TABLE federation_subjects (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  tenant TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  external_id TEXT,
  scim_user_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','active','suspended')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id,provider_id) REFERENCES federation_providers(account_id,id),
  FOREIGN KEY (account_id,provider_id,scim_user_id) REFERENCES federation_scim_users(account_id,provider_id,id),
  UNIQUE (account_id,provider_id,subject),
  UNIQUE (account_id,provider_id,user_id),
  UNIQUE (account_id,provider_id,id)
);
CREATE UNIQUE INDEX federation_subject_external ON federation_subjects(account_id,provider_id,external_id) WHERE external_id IS NOT NULL;
CREATE INDEX federation_subject_user ON federation_subjects(user_id,account_id,state);

CREATE TABLE federation_scim_groups (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  display_name_key TEXT NOT NULL,
  team_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (account_id,provider_id) REFERENCES federation_providers(account_id,id),
  UNIQUE (account_id,provider_id,id)
);
CREATE UNIQUE INDEX federation_scim_group_live_team ON federation_scim_groups(account_id,team_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX federation_scim_group_live_external ON federation_scim_groups(account_id,provider_id,external_id) WHERE deleted_at IS NULL;
CREATE INDEX federation_scim_groups_cursor ON federation_scim_groups(account_id,provider_id,id) WHERE deleted_at IS NULL;
CREATE INDEX federation_scim_group_names ON federation_scim_groups(account_id,provider_id,display_name_key) WHERE deleted_at IS NULL;

-- The immutable team ID remains in history. Only live Groups pin a live team.
CREATE TRIGGER federation_scim_group_team_insert BEFORE INSERT ON federation_scim_groups
WHEN NEW.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM teams WHERE account_id=NEW.account_id AND id=NEW.team_id)
BEGIN SELECT RAISE(ABORT, 'federation_live_team_required'); END;
CREATE TRIGGER federation_scim_group_team_update BEFORE UPDATE OF account_id,team_id,deleted_at ON federation_scim_groups
WHEN NEW.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM teams WHERE account_id=NEW.account_id AND id=NEW.team_id)
BEGIN SELECT RAISE(ABORT, 'federation_live_team_required'); END;
CREATE TRIGGER federation_scim_live_team_delete BEFORE DELETE ON teams
WHEN EXISTS (SELECT 1 FROM federation_scim_groups WHERE account_id=OLD.account_id AND team_id=OLD.id AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'team_managed_by_scim'); END;

CREATE TABLE federation_scim_group_members (
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  scim_user_id TEXT NOT NULL,
  PRIMARY KEY (account_id,provider_id,group_id,scim_user_id),
  FOREIGN KEY (account_id,provider_id,group_id) REFERENCES federation_scim_groups(account_id,provider_id,id),
  FOREIGN KEY (account_id,provider_id,scim_user_id) REFERENCES federation_scim_users(account_id,provider_id,id)
);
CREATE INDEX federation_scim_members_user ON federation_scim_group_members(account_id,provider_id,scim_user_id,group_id);

-- Only memberships created by federation are removed by mapping reconciliation.
CREATE TABLE federation_team_memberships (
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('sso','scim')),
  source_id TEXT NOT NULL,
  PRIMARY KEY (account_id,provider_id,user_id,team_id,source,source_id),
  FOREIGN KEY (account_id,provider_id) REFERENCES federation_providers(account_id,id),
  FOREIGN KEY (account_id,team_id) REFERENCES teams(account_id,id)
);
CREATE INDEX federation_managed_team_users ON federation_team_memberships(account_id,user_id,team_id);

CREATE TABLE federation_provisioning_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE REFERENCES credentials(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (account_id,provider_id) REFERENCES federation_providers(account_id,id)
);
CREATE INDEX federation_provisioning_tokens_account ON federation_provisioning_tokens(account_id,provider_id,id);

-- A session remains a core session credential. This additional record restricts its
-- organization scope and assurance; it is not a parallel bearer authentication system.
CREATE TABLE federation_session_grants (
  account_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  provider_id TEXT NOT NULL,
  provider_revision INTEGER NOT NULL,
  policy_revision INTEGER NOT NULL,
  subject_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  authenticated_at TEXT NOT NULL,
  mfa INTEGER NOT NULL CHECK (mfa=1),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (account_id,credential_id),
  FOREIGN KEY (account_id,provider_id,subject_id) REFERENCES federation_subjects(account_id,provider_id,id)
);
CREATE INDEX federation_grants_credential ON federation_session_grants(credential_id,account_id);
CREATE INDEX federation_grants_provider ON federation_session_grants(account_id,provider_id,revoked_at);
CREATE INDEX federation_grants_user ON federation_session_grants(account_id,user_id,revoked_at);

-- Written/decrypted only through the private SECRETS broker. Each immutable version
-- has its own random DEK and separate AES-GCM payload/wrapping nonces.
CREATE TABLE federation_client_secrets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('oidc_client_secret','saml_signing_key')),
  version INTEGER NOT NULL CHECK (version>0),
  context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  wrap_iv TEXT NOT NULL,
  kek_id TEXT NOT NULL,
  public_certificate TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (account_id,provider_id) REFERENCES federation_providers(account_id,id),
  UNIQUE (account_id,provider_id,kind,version)
);
CREATE UNIQUE INDEX federation_secret_current ON federation_client_secrets(account_id,provider_id,kind) WHERE revoked_at IS NULL;
CREATE INDEX federation_secret_keys ON federation_client_secrets(kek_id,id);

-- Broker write retries use a keyed fingerprint and an atomic outcome, never a
-- cached plaintext value or an unguarded retry of a timed-out rotation.
CREATE TABLE federation_secret_operations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id,provider_id) REFERENCES federation_providers(account_id,id)
);
CREATE INDEX federation_secret_operations_provider ON federation_secret_operations(account_id,provider_id,id);

CREATE TABLE federation_secret_wraps (
  id TEXT PRIMARY KEY,
  secret_id TEXT NOT NULL REFERENCES federation_client_secrets(id),
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version>1),
  kek_id TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  wrap_iv TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id,provider_id) REFERENCES federation_providers(account_id,id),
  UNIQUE (secret_id,version)
);
CREATE INDEX federation_wrap_current ON federation_secret_wraps(secret_id,version DESC);

CREATE TABLE federation_rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (bucket,window_start)
);
CREATE INDEX federation_rate_limits_expiry ON federation_rate_limits(expires_at);

CREATE TABLE federation_scim_requests (
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation>0),
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','uncertain','complete')),
  lease_expires_at TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('User','Group')),
  planned_resource_id TEXT NOT NULL,
  planned_user_id TEXT,
  resource_id TEXT,
  event_id TEXT,
  audit_id TEXT,
  committed_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id,provider_id,credential_id,request_key),
  FOREIGN KEY (account_id,provider_id) REFERENCES federation_providers(account_id,id)
);
CREATE INDEX federation_scim_requests_expiry ON federation_scim_requests(expires_at);
CREATE INDEX federation_scim_request_takeover ON federation_scim_requests(status,lease_expires_at,id) WHERE committed_at IS NULL;

-- Admission intent survives a Worker crash before/after the shared billing call.
-- A cancelling state fences the membership writer before releasing any hold.
CREATE TABLE federation_seat_admissions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('flow','scim','membership')),
  source_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  source_attempt TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  request_hash TEXT NOT NULL,
  expected_billing_revision INTEGER NOT NULL,
  reservation_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('preparing','reserved','consumed','cancelling','cancelled')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id,provider_id) REFERENCES federation_providers(account_id,id)
);
CREATE INDEX federation_seat_admission_source ON federation_seat_admissions(source_kind,source_id,source_generation,state);
CREATE INDEX federation_seat_admission_recovery ON federation_seat_admissions(state,expires_at,id);

CREATE TABLE federation_write_guards (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CONSTRAINT federation_guard CHECK (ok=1)
);

-- These invalidations execute in the same SQLite transaction as membership changes,
-- including writes made by identity endpoints rather than by SCIM.
-- The target is transient within that transaction. A shared local login is not
-- an organization credential; its access is checked against the current ACL.
CREATE TABLE federation_revocation_targets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  provider_id TEXT,
  revoked_at TEXT NOT NULL
);
CREATE TRIGGER federation_revoke_scoped_credentials AFTER INSERT ON federation_revocation_targets
BEGIN
  UPDATE credentials SET revoked_at=NEW.revoked_at,revision=revision+1
   WHERE revoked_at IS NULL AND id IN (
     WITH RECURSIVE affected(id) AS (
       SELECT c.id FROM credentials c WHERE
         (c.principal_id=NEW.principal_id OR c.user_id=NEW.principal_id OR c.created_by=NEW.principal_id)
         AND (
           (EXISTS (SELECT 1 FROM federation_session_grants g WHERE g.credential_id=c.id AND g.account_id=NEW.account_id
             AND g.user_id=NEW.principal_id AND (NEW.provider_id IS NULL OR g.provider_id=NEW.provider_id))
            AND NOT EXISTS (SELECT 1 FROM federation_session_grants g WHERE g.credential_id=c.id
              AND g.revoked_at IS NULL AND g.expires_at>NEW.revoked_at
              AND (g.account_id<>NEW.account_id OR (NEW.provider_id IS NOT NULL AND g.provider_id<>NEW.provider_id))))
           OR (NEW.provider_id IS NULL AND NOT EXISTS (SELECT 1 FROM federation_session_grants g WHERE g.credential_id=c.id)
             AND ((c.account_ids_json IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(c.account_ids_json) WHERE value=NEW.account_id))
               OR (c.account_ids_json IS NULL AND c.repository_ids_json IS NOT NULL AND EXISTS
                 (SELECT 1 FROM repositories r JOIN json_each(c.repository_ids_json) ids ON ids.value=r.id WHERE r.owner_id=NEW.account_id))
               OR (c.account_ids_json IS NULL AND c.repository_ids_json IS NULL AND EXISTS
                 (SELECT 1 FROM principals p WHERE p.id=c.principal_id AND p.kind<>'user' AND p.account_id=NEW.account_id))))
         )
       UNION SELECT c.id FROM credentials c JOIN affected parent ON c.parent_id=parent.id
     ) SELECT id FROM affected
   );
  UPDATE federation_session_grants SET revoked_at=COALESCE(revoked_at,NEW.revoked_at)
   WHERE account_id=NEW.account_id AND user_id=NEW.principal_id AND (NEW.provider_id IS NULL OR provider_id=NEW.provider_id);
  DELETE FROM federation_revocation_targets WHERE id=NEW.id;
END;
CREATE TRIGGER federation_member_added AFTER INSERT ON memberships
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=NEW.account_id;
  INSERT INTO federation_revocation_targets(id,account_id,principal_id,revoked_at)
   VALUES (lower(hex(randomblob(16))),NEW.account_id,NEW.principal_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER federation_member_changed AFTER UPDATE OF role_id,state ON memberships
WHEN OLD.role_id<>NEW.role_id OR OLD.state<>NEW.state
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=NEW.account_id;
  INSERT INTO federation_revocation_targets(id,account_id,principal_id,revoked_at)
   VALUES (lower(hex(randomblob(16))),NEW.account_id,NEW.principal_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER federation_member_removed AFTER DELETE ON memberships
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=OLD.account_id;
  INSERT INTO federation_revocation_targets(id,account_id,principal_id,revoked_at)
   VALUES (lower(hex(randomblob(16))),OLD.account_id,OLD.principal_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER federation_team_member_added AFTER INSERT ON team_members
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=NEW.account_id;
  INSERT INTO federation_revocation_targets(id,account_id,principal_id,revoked_at)
   VALUES (lower(hex(randomblob(16))),NEW.account_id,NEW.principal_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER federation_team_member_changed AFTER UPDATE OF role ON team_members
WHEN OLD.role<>NEW.role
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=NEW.account_id;
  INSERT INTO federation_revocation_targets(id,account_id,principal_id,revoked_at)
   VALUES (lower(hex(randomblob(16))),NEW.account_id,NEW.principal_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER federation_team_member_removed AFTER DELETE ON team_members
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=OLD.account_id;
  INSERT INTO federation_revocation_targets(id,account_id,principal_id,revoked_at)
   VALUES (lower(hex(randomblob(16))),OLD.account_id,OLD.principal_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER federation_provider_changed AFTER UPDATE OF revision ON federation_providers
WHEN OLD.revision<>NEW.revision
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=NEW.account_id;
  INSERT INTO federation_revocation_targets(id,account_id,principal_id,provider_id,revoked_at)
   SELECT lower(hex(randomblob(16))),NEW.account_id,user_id,NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
   FROM (SELECT DISTINCT user_id FROM federation_session_grants WHERE account_id=NEW.account_id AND provider_id=NEW.id);
  UPDATE federation_auth_flows SET consumed_at=COALESCE(consumed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),pkce_verifier=NULL
   WHERE account_id=NEW.account_id AND provider_id=NEW.id AND provider_revision<>NEW.revision;
  UPDATE credentials SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
   WHERE revoked_at IS NULL AND (NEW.enabled=0 OR NEW.deleted_at IS NOT NULL)
     AND id IN (SELECT credential_id FROM federation_provisioning_tokens WHERE account_id=NEW.account_id AND provider_id=NEW.id);
END;
CREATE TRIGGER federation_policy_changed AFTER UPDATE OF revision ON federation_org_policies
WHEN OLD.revision<>NEW.revision
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=NEW.account_id;
  INSERT INTO federation_revocation_targets(id,account_id,principal_id,revoked_at)
   SELECT lower(hex(randomblob(16))),NEW.account_id,user_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
   FROM (SELECT DISTINCT user_id FROM federation_session_grants WHERE account_id=NEW.account_id);
END;
CREATE TRIGGER federation_policy_created AFTER INSERT ON federation_org_policies
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=NEW.account_id;
  INSERT INTO federation_revocation_targets(id,account_id,principal_id,revoked_at)
   SELECT lower(hex(randomblob(16))),NEW.account_id,user_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
   FROM (SELECT DISTINCT user_id FROM federation_session_grants WHERE account_id=NEW.account_id);
END;
