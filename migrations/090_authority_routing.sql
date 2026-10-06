-- Identity-primary control state. These tables must not be copied as repository data.
CREATE TABLE account_authority_epochs (
  account_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  phase TEXT NOT NULL CHECK (phase IN ('active','fencing','fenced','releasing')),
  barrier_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((phase='active') = (barrier_id IS NULL))
);

-- Enrollment is permanent: an old/delayed placement must still be fenced.
CREATE TABLE account_authority_placements (
  account_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  acknowledged_epoch INTEGER NOT NULL DEFAULT 0,
  acknowledged_phase TEXT CHECK (acknowledged_phase IN ('active','fenced')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id,cell_id,shard_id)
);

CREATE TABLE account_authority_repositories (
  account_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id,repo_id,cell_id,shard_id,epoch)
);
CREATE INDEX account_authority_repository_lookup ON account_authority_repositories(repo_id,epoch);

-- Placement-local CAS fences. Installation is an authenticated, acknowledged RPC.
CREATE TABLE account_authority_fences (
  account_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  phase TEXT NOT NULL CHECK (phase IN ('active','fenced')),
  barrier_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((phase='active') = (barrier_id IS NULL))
);
CREATE TRIGGER account_authority_fence_monotonic BEFORE UPDATE ON account_authority_fences
WHEN NEW.epoch < OLD.epoch OR (NEW.epoch=OLD.epoch AND
  (NEW.policy_revision<>OLD.policy_revision OR NEW.phase<>OLD.phase OR NEW.barrier_id IS NOT OLD.barrier_id))
BEGIN SELECT RAISE(ABORT,'account_authority_epoch_regression'); END;

-- Immutable global resource -> repository locators, stored on IDENTITY_DB.
-- NULL repo_id denotes an identity/account-owned global resource.
CREATE TABLE resource_locators (
  resource_id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  repo_id TEXT,
  authority TEXT NOT NULL CHECK (authority IN ('identity','repository')),
  created_at TEXT NOT NULL,
  CHECK (authority='identity' OR repo_id IS NOT NULL)
);
CREATE INDEX resource_locators_repository ON resource_locators(repo_id,resource_id);
CREATE TRIGGER resource_locator_immutable BEFORE UPDATE ON resource_locators
WHEN NEW.resource_id<>OLD.resource_id OR NEW.resource_type<>OLD.resource_type OR NEW.repo_id IS NOT OLD.repo_id OR NEW.authority<>OLD.authority
BEGIN SELECT RAISE(ABORT,'resource_locator_immutable'); END;
CREATE TRIGGER resource_locator_retained BEFORE DELETE ON resource_locators
BEGIN SELECT RAISE(ABORT,'resource_locator_retained'); END;

-- The primary cannot commit revocation while any enrolled writer can still use
-- its previous authority. Empty enrollment keeps the initial single-DB path.
CREATE VIEW account_authority_unfenced AS
SELECT DISTINCT p.account_id FROM account_authority_placements p
WHERE NOT EXISTS (SELECT 1 FROM account_authority_epochs e
  JOIN account_policy_barriers b ON b.account_id=e.account_id AND b.id=e.barrier_id
  WHERE e.account_id=p.account_id AND e.phase='fenced'
    AND NOT EXISTS (SELECT 1 FROM account_authority_placements a WHERE a.account_id=e.account_id
      AND (a.acknowledged_epoch<>e.epoch OR a.acknowledged_phase IS NOT 'fenced')));

CREATE TRIGGER account_authority_policy_write BEFORE UPDATE OF policy_revision,disabled_at ON accounts
WHEN (NEW.policy_revision<>OLD.policy_revision OR NEW.disabled_at IS NOT OLD.disabled_at)
  AND EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;

CREATE TRIGGER account_authority_user_write BEFORE UPDATE OF auth_revision,disabled_at,email_verified_at ON users
WHEN (NEW.auth_revision<>OLD.auth_revision OR NEW.disabled_at IS NOT OLD.disabled_at OR NEW.email_verified_at IS NOT OLD.email_verified_at)
  AND EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;

CREATE TRIGGER account_authority_principal_write BEFORE UPDATE OF disabled_at,expires_at,account_id,kind,user_id ON principals
WHEN (NEW.disabled_at IS NOT OLD.disabled_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.account_id IS NOT OLD.account_id
  OR NEW.kind<>OLD.kind OR NEW.user_id IS NOT OLD.user_id)
  AND EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id IN (OLD.account_id,NEW.account_id,OLD.user_id,NEW.user_id))
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;

CREATE TRIGGER account_authority_credential_write BEFORE UPDATE OF revoked_at,capabilities_json,repository_ids_json,account_ids_json,ref_patterns_json,path_patterns_json,expires_at,parent_id,auth_revision,principal_id,user_id,kind,mfa ON credentials
WHEN (NEW.revoked_at IS NOT OLD.revoked_at OR NEW.capabilities_json IS NOT OLD.capabilities_json
  OR NEW.repository_ids_json IS NOT OLD.repository_ids_json OR NEW.account_ids_json IS NOT OLD.account_ids_json
  OR NEW.ref_patterns_json IS NOT OLD.ref_patterns_json OR NEW.path_patterns_json IS NOT OLD.path_patterns_json
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.parent_id IS NOT OLD.parent_id OR NEW.auth_revision IS NOT OLD.auth_revision
  OR NEW.principal_id<>OLD.principal_id OR NEW.user_id IS NOT OLD.user_id OR NEW.kind<>OLD.kind OR NEW.mfa<>OLD.mfa)
  AND EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id=OLD.user_id
    OR account_id IN (SELECT account_id FROM principals WHERE id=OLD.principal_id))
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;

CREATE TRIGGER account_authority_live_credential_delete BEFORE DELETE ON credentials
WHEN OLD.revoked_at IS NULL AND OLD.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id=OLD.user_id
    OR account_id IN (SELECT account_id FROM principals WHERE id=OLD.principal_id))
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;

CREATE TRIGGER account_authority_membership_insert BEFORE INSERT ON memberships
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;
CREATE TRIGGER account_authority_membership_update BEFORE UPDATE ON memberships
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id IN (OLD.account_id,NEW.account_id))
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;
CREATE TRIGGER account_authority_membership_delete BEFORE DELETE ON memberships
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id=OLD.account_id)
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;

CREATE TRIGGER account_authority_policy_insert BEFORE INSERT ON account_policies
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;
CREATE TRIGGER account_authority_policy_update BEFORE UPDATE ON account_policies
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id IN (OLD.account_id,NEW.account_id))
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;
CREATE TRIGGER account_authority_policy_delete BEFORE DELETE ON account_policies
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id=OLD.account_id)
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;

CREATE TRIGGER account_authority_grant_insert BEFORE INSERT ON access_grants
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;
CREATE TRIGGER account_authority_grant_update BEFORE UPDATE ON access_grants
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id IN (OLD.account_id,NEW.account_id))
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;
CREATE TRIGGER account_authority_grant_delete BEFORE DELETE ON access_grants
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id=OLD.account_id)
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;

CREATE TRIGGER account_authority_role_update BEFORE UPDATE ON roles
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id IN (OLD.account_id,NEW.account_id))
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;
CREATE TRIGGER account_authority_role_delete BEFORE DELETE ON roles
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id=OLD.account_id)
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;
CREATE TRIGGER account_authority_role_capability_insert BEFORE INSERT ON role_capabilities
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id IN (SELECT account_id FROM roles WHERE id=NEW.role_id))
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;
CREATE TRIGGER account_authority_role_capability_delete BEFORE DELETE ON role_capabilities
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id IN (SELECT account_id FROM roles WHERE id=OLD.role_id))
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;
CREATE TRIGGER account_authority_role_capability_update BEFORE UPDATE ON role_capabilities
WHEN EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id IN (SELECT account_id FROM roles WHERE id IN (OLD.role_id,NEW.role_id)))
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;

CREATE TRIGGER account_authority_barrier_release BEFORE DELETE ON account_policy_barriers
WHEN EXISTS (SELECT 1 FROM account_authority_epochs WHERE account_id=OLD.account_id AND barrier_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'account_authority_release_required'); END;

-- Audience changes must invalidate cross-repository decisions too. Metadata
-- shards have only local fences; the identity primary also has enrollment rows.
CREATE TRIGGER account_authority_repository_audience BEFORE UPDATE OF owner_id,visibility,fork_source_id,state ON repositories
WHEN (NEW.owner_id<>OLD.owner_id OR NEW.visibility<>OLD.visibility OR NEW.fork_source_id IS NOT OLD.fork_source_id
  OR (NEW.state<>OLD.state AND (NEW.state='deleted' OR OLD.state='deleted')))
  AND (EXISTS (SELECT 1 FROM account_authority_unfenced WHERE account_id=OLD.owner_id)
    OR EXISTS (SELECT 1 FROM account_authority_fences WHERE account_id=OLD.owner_id AND phase<>'fenced'))
BEGIN SELECT RAISE(ABORT,'account_authority_barrier_required'); END;
