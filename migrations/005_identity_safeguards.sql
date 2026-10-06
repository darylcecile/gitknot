-- Recovery invariants are enforced inside SQLite, including indirect changes.
CREATE VIEW identity_recovery_capabilities AS
SELECT value AS capability FROM json_each('["owners.manage","accounts.manage","members.manage","roles.manage","policy.manage","permissions.manage","tokens.manage","identities.manage","identities.read"]');

-- A recovery owner is a permanent, independently recoverable human whose owner
-- capabilities survive the account ceiling and every applicable direct/team deny.
-- Future denials count too: a scheduled deny cannot silently remove recovery.
CREATE VIEW identity_effective_owners AS
SELECT m.account_id,m.principal_id
FROM memberships m JOIN accounts a ON a.id=m.account_id
JOIN users u ON u.id=m.principal_id JOIN principals p ON p.id=u.id
LEFT JOIN account_policies ap ON ap.account_id=a.id
WHERE a.type='organization' AND a.disabled_at IS NULL
  AND m.role_id='owner' AND m.state='active'
  AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL
  AND p.kind='user' AND p.user_id=u.id AND p.disabled_at IS NULL AND p.expires_at IS NULL
  AND (p.account_id IS NULL OR EXISTS (SELECT 1 FROM accounts home WHERE home.id=p.account_id AND home.disabled_at IS NULL))
  AND (u.password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM passkeys k WHERE k.user_id=u.id))
  AND (ap.account_id IS NULL OR json_type(ap.config_json)='object')
  AND ((u.mfa_required=0 AND COALESCE(json_extract(ap.config_json,'$.require_mfa'),0)=0)
    OR EXISTS (SELECT 1 FROM passkeys k WHERE k.user_id=u.id)
    OR EXISTS (SELECT 1 FROM user_mfa f WHERE f.user_id=u.id AND f.enabled_at IS NOT NULL))
  AND (json_type(ap.config_json,'$.allowed_credential_kinds') IS NULL
    OR EXISTS (SELECT 1 FROM json_each(ap.config_json,'$.allowed_credential_kinds') WHERE value='session'))
  AND NOT EXISTS (
    SELECT 1 FROM identity_recovery_capabilities need WHERE
      NOT EXISTS (SELECT 1 FROM role_capabilities rc WHERE rc.role_id='owner' AND rc.effect='allow'
        AND (rc.capability='*' OR rc.capability=need.capability OR
          (substr(rc.capability,-2)='.*' AND substr(need.capability,1,length(rc.capability)-1)=substr(rc.capability,1,length(rc.capability)-1))))
      OR EXISTS (SELECT 1 FROM role_capabilities rc WHERE rc.role_id='owner' AND rc.effect='deny'
        AND (rc.capability='*' OR rc.capability=need.capability OR
          (substr(rc.capability,-2)='.*' AND substr(need.capability,1,length(rc.capability)-1)=substr(rc.capability,1,length(rc.capability)-1))))
      OR (json_type(ap.config_json,'$.allowed_capabilities') NOT IN ('null')
        AND NOT EXISTS (SELECT 1 FROM json_each(ap.config_json,'$.allowed_capabilities') allowed
          WHERE allowed.value='*' OR allowed.value=need.capability OR
            (substr(allowed.value,-2)='.*' AND substr(need.capability,1,length(allowed.value)-1)=substr(allowed.value,1,length(allowed.value)-1))))
      OR EXISTS (SELECT 1 FROM json_each(ap.config_json,'$.denied_capabilities') denied
        WHERE denied.value='*' OR denied.value=need.capability OR
          (substr(denied.value,-2)='.*' AND substr(need.capability,1,length(denied.value)-1)=substr(denied.value,1,length(denied.value)-1)))
      OR EXISTS (
        SELECT 1 FROM access_grants g LEFT JOIN roles r ON r.id=g.role_id
        LEFT JOIN role_capabilities rc ON rc.role_id=g.role_id
        WHERE g.account_id=a.id AND g.repo_id IS NULL AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          AND (json_extract(g.conditions_json,'$.expires_at') IS NULL OR json_extract(g.conditions_json,'$.expires_at')>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          AND (g.role_id IS NULL OR r.built_in=1 OR (r.account_id=a.id AND r.repo_id IS NULL))
          AND (g.effect='deny' OR rc.effect='deny')
          AND ((g.principal_type='user' AND g.principal_id=u.id) OR
            (g.principal_type='team' AND EXISTS (SELECT 1 FROM team_members tm
              WHERE tm.account_id=a.id AND tm.team_id=g.principal_id AND tm.principal_id=u.id)))
          AND (COALESCE(g.capability,rc.capability)='*' OR COALESCE(g.capability,rc.capability)=need.capability OR
            (substr(COALESCE(g.capability,rc.capability),-2)='.*'
              AND substr(need.capability,1,length(COALESCE(g.capability,rc.capability))-1)=substr(COALESCE(g.capability,rc.capability),1,length(COALESCE(g.capability,rc.capability))-1)))
      )
  );

CREATE TABLE identity_owner_checks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  ok INTEGER NOT NULL CONSTRAINT last_recoverable_owner CHECK (ok=1)
);

CREATE TRIGGER memberships_owner_insert BEFORE INSERT ON memberships
WHEN NEW.role_id = 'owner' AND NOT EXISTS (
  SELECT 1 FROM users u JOIN principals p ON p.id = u.id
  WHERE u.id = NEW.principal_id AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL
    AND p.kind = 'user' AND p.user_id=u.id AND p.disabled_at IS NULL AND p.expires_at IS NULL
    AND (u.password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM passkeys k WHERE k.user_id = u.id))
)
BEGIN SELECT RAISE(ABORT, 'owner_must_be_recoverable'); END;

CREATE TRIGGER memberships_owner_assign BEFORE UPDATE OF role_id, principal_id, state ON memberships
WHEN NEW.role_id = 'owner' AND NEW.state = 'active' AND NOT EXISTS (
  SELECT 1 FROM users u JOIN principals p ON p.id = u.id
  WHERE u.id = NEW.principal_id AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL
    AND p.kind = 'user' AND p.user_id=u.id AND p.disabled_at IS NULL AND p.expires_at IS NULL
    AND (u.password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM passkeys k WHERE k.user_id = u.id))
)
BEGIN SELECT RAISE(ABORT, 'owner_must_be_recoverable'); END;

CREATE TRIGGER memberships_last_owner_update BEFORE UPDATE OF role_id, state, principal_id ON memberships
WHEN OLD.role_id = 'owner' AND OLD.state = 'active'
 AND (NEW.role_id != 'owner' OR NEW.state != 'active' OR NEW.principal_id != OLD.principal_id)
 AND EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id AND type = 'organization' AND disabled_at IS NULL)
 AND NOT EXISTS (
  SELECT 1 FROM identity_effective_owners WHERE account_id=OLD.account_id AND principal_id!=OLD.principal_id
 )
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;

CREATE TRIGGER memberships_last_owner_delete BEFORE DELETE ON memberships
WHEN OLD.role_id = 'owner' AND OLD.state = 'active'
 AND EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id AND type = 'organization' AND disabled_at IS NULL)
 AND NOT EXISTS (
  SELECT 1 FROM identity_effective_owners WHERE account_id=OLD.account_id AND principal_id!=OLD.principal_id
 )
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;

CREATE TRIGGER users_last_owner_update BEFORE UPDATE OF disabled_at, email_verified_at, password_hash ON users
WHEN (NEW.disabled_at IS NOT NULL OR NEW.email_verified_at IS NULL OR
 (NEW.password_hash IS NULL AND NOT EXISTS (SELECT 1 FROM passkeys k WHERE k.user_id = OLD.id)))
 AND EXISTS (
  SELECT 1 FROM memberships mine JOIN accounts a ON a.id = mine.account_id
  WHERE mine.principal_id = OLD.id AND mine.role_id = 'owner' AND mine.state = 'active'
    AND a.type = 'organization' AND a.disabled_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM identity_effective_owners WHERE account_id=mine.account_id AND principal_id!=OLD.id
    )
 )
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;

CREATE TRIGGER principals_last_owner_update BEFORE UPDATE OF disabled_at ON principals
WHEN NEW.kind = 'user' AND NEW.disabled_at IS NOT NULL AND EXISTS (
 SELECT 1 FROM memberships mine JOIN accounts a ON a.id = mine.account_id
 WHERE mine.principal_id = OLD.id AND mine.role_id = 'owner' AND mine.state = 'active'
 AND a.type = 'organization' AND a.disabled_at IS NULL AND NOT EXISTS (
   SELECT 1 FROM identity_effective_owners WHERE account_id=mine.account_id AND principal_id!=OLD.id
 ))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;

CREATE TRIGGER passkeys_last_authenticator BEFORE DELETE ON passkeys
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id AND password_hash IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = OLD.user_id AND id != OLD.id)
BEGIN SELECT RAISE(ABORT, 'last_authenticator'); END;

CREATE TRIGGER memberships_personal_owner_update BEFORE UPDATE OF role_id, state, principal_id ON memberships
WHEN EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id AND type = 'user' AND owner_user_id = OLD.principal_id)
 AND (NEW.role_id != 'owner' OR NEW.state != 'active' OR NEW.principal_id != OLD.principal_id)
BEGIN SELECT RAISE(ABORT, 'personal_owner_immutable'); END;

CREATE TRIGGER memberships_personal_owner_delete BEFORE DELETE ON memberships
WHEN EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id AND type = 'user' AND owner_user_id = OLD.principal_id AND disabled_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'personal_owner_immutable'); END;

CREATE TRIGGER repositories_internal_owner_insert BEFORE INSERT ON repositories
WHEN NEW.visibility = 'internal' AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.owner_id AND type = 'organization')
BEGIN SELECT RAISE(ABORT, 'internal_requires_organization'); END;

CREATE TRIGGER effective_owner_team_insert AFTER INSERT ON team_members
WHEN EXISTS (SELECT 1 FROM accounts WHERE id=NEW.account_id AND type='organization' AND disabled_at IS NULL)
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;
CREATE TRIGGER effective_owner_team_update AFTER UPDATE ON team_members
WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.id IN (OLD.account_id,NEW.account_id) AND a.type='organization' AND a.disabled_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners e WHERE e.account_id=a.id))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;
CREATE TRIGGER effective_owner_team_delete AFTER DELETE ON team_members
WHEN EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id AND type='organization' AND disabled_at IS NULL)
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners WHERE account_id=OLD.account_id)
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;

CREATE TRIGGER effective_owner_membership_insert AFTER INSERT ON memberships
WHEN EXISTS (SELECT 1 FROM accounts WHERE id=NEW.account_id AND type='organization' AND disabled_at IS NULL)
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;
CREATE TRIGGER effective_owner_membership_update AFTER UPDATE ON memberships
WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.id IN (OLD.account_id,NEW.account_id) AND a.type='organization' AND a.disabled_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners e WHERE e.account_id=a.id))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;
CREATE TRIGGER effective_owner_membership_delete AFTER DELETE ON memberships
WHEN EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id AND type='organization' AND disabled_at IS NULL)
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners WHERE account_id=OLD.account_id)
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;

CREATE TRIGGER effective_owner_grant_insert AFTER INSERT ON access_grants
WHEN EXISTS (SELECT 1 FROM accounts WHERE id=NEW.account_id AND type='organization' AND disabled_at IS NULL)
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;
CREATE TRIGGER effective_owner_grant_update AFTER UPDATE ON access_grants
WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.id IN (OLD.account_id,NEW.account_id) AND a.type='organization' AND a.disabled_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners e WHERE e.account_id=a.id))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;

CREATE TRIGGER effective_owner_policy_insert AFTER INSERT ON account_policies
WHEN EXISTS (SELECT 1 FROM accounts WHERE id=NEW.account_id AND type='organization' AND disabled_at IS NULL)
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;
CREATE TRIGGER effective_owner_policy_update AFTER UPDATE ON account_policies
WHEN EXISTS (SELECT 1 FROM accounts WHERE id=NEW.account_id AND type='organization' AND disabled_at IS NULL)
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners WHERE account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;

CREATE TRIGGER effective_owner_user_update AFTER UPDATE OF disabled_at,email_verified_at,password_hash,mfa_required ON users
WHEN EXISTS (SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.account_id
 WHERE m.principal_id=NEW.id AND m.role_id='owner' AND m.state='active' AND a.type='organization' AND a.disabled_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners e WHERE e.account_id=m.account_id))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;
CREATE TRIGGER effective_owner_principal_update AFTER UPDATE OF disabled_at,expires_at,kind,user_id,account_id ON principals
WHEN EXISTS (SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.account_id
 WHERE m.principal_id=NEW.id AND m.role_id='owner' AND m.state='active' AND a.type='organization' AND a.disabled_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners e WHERE e.account_id=m.account_id))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;
CREATE TRIGGER effective_owner_home_account_update AFTER UPDATE OF disabled_at ON accounts
WHEN NEW.disabled_at IS NOT NULL AND EXISTS (
 SELECT 1 FROM memberships m JOIN principals p ON p.id=m.principal_id JOIN accounts a ON a.id=m.account_id
 WHERE p.account_id=NEW.id AND m.role_id='owner' AND m.state='active' AND a.type='organization' AND a.disabled_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners e WHERE e.account_id=m.account_id))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;

CREATE TRIGGER effective_owner_passkey_delete AFTER DELETE ON passkeys
WHEN EXISTS (SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.account_id
 WHERE m.principal_id=OLD.user_id AND m.role_id='owner' AND m.state='active' AND a.type='organization' AND a.disabled_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners e WHERE e.account_id=m.account_id))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;
CREATE TRIGGER effective_owner_mfa_delete AFTER DELETE ON user_mfa
WHEN EXISTS (SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.account_id
 WHERE m.principal_id=OLD.user_id AND m.role_id='owner' AND m.state='active' AND a.type='organization' AND a.disabled_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners e WHERE e.account_id=m.account_id))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;
CREATE TRIGGER effective_owner_mfa_update AFTER UPDATE OF enabled_at ON user_mfa
WHEN EXISTS (SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.account_id
 WHERE m.principal_id=NEW.user_id AND m.role_id='owner' AND m.state='active' AND a.type='organization' AND a.disabled_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners e WHERE e.account_id=m.account_id))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;

CREATE TRIGGER effective_owner_role_capability_insert AFTER INSERT ON role_capabilities
WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.type='organization' AND a.disabled_at IS NULL
 AND (EXISTS (SELECT 1 FROM memberships m WHERE m.account_id=a.id AND m.role_id=NEW.role_id)
   OR EXISTS (SELECT 1 FROM access_grants g WHERE g.account_id=a.id AND g.role_id=NEW.role_id AND g.repo_id IS NULL AND g.revoked_at IS NULL))
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners e WHERE e.account_id=a.id))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;
CREATE TRIGGER effective_owner_role_capability_update AFTER UPDATE ON role_capabilities
WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.type='organization' AND a.disabled_at IS NULL
 AND (EXISTS (SELECT 1 FROM memberships m WHERE m.account_id=a.id AND m.role_id IN (OLD.role_id,NEW.role_id))
   OR EXISTS (SELECT 1 FROM access_grants g WHERE g.account_id=a.id AND g.role_id IN (OLD.role_id,NEW.role_id) AND g.repo_id IS NULL AND g.revoked_at IS NULL))
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners e WHERE e.account_id=a.id))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;

CREATE TRIGGER effective_owner_role_capability_delete AFTER DELETE ON role_capabilities
WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.type='organization' AND a.disabled_at IS NULL
 AND (EXISTS (SELECT 1 FROM memberships m WHERE m.account_id=a.id AND m.role_id=OLD.role_id)
   OR EXISTS (SELECT 1 FROM access_grants g WHERE g.account_id=a.id AND g.role_id=OLD.role_id AND g.repo_id IS NULL AND g.revoked_at IS NULL))
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners e WHERE e.account_id=a.id))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;

CREATE TRIGGER effective_owner_role_scope_update AFTER UPDATE OF account_id,repo_id,built_in ON roles
WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.type='organization' AND a.disabled_at IS NULL
 AND (EXISTS (SELECT 1 FROM memberships m WHERE m.account_id=a.id AND m.role_id=NEW.id)
   OR EXISTS (SELECT 1 FROM access_grants g WHERE g.account_id=a.id AND g.role_id=NEW.id AND g.repo_id IS NULL AND g.revoked_at IS NULL))
 AND NOT EXISTS (SELECT 1 FROM identity_effective_owners e WHERE e.account_id=a.id))
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;
CREATE TRIGGER repositories_internal_owner_update BEFORE UPDATE OF owner_id, visibility ON repositories
WHEN NEW.visibility = 'internal' AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.owner_id AND type = 'organization')
BEGIN SELECT RAISE(ABORT, 'internal_requires_organization'); END;
