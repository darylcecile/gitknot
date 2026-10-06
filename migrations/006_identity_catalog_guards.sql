CREATE TABLE account_aliases (
  slug TEXT PRIMARY KEY COLLATE NOCASE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX account_aliases_account ON account_aliases(account_id);

CREATE TRIGGER accounts_reserved_alias_insert BEFORE INSERT ON accounts
WHEN EXISTS (SELECT 1 FROM account_aliases WHERE slug=NEW.slug AND account_id!=NEW.id)
BEGIN SELECT RAISE(ABORT, 'account_name_reserved'); END;
CREATE TRIGGER accounts_reserved_alias_update BEFORE UPDATE OF slug ON accounts
WHEN EXISTS (SELECT 1 FROM account_aliases WHERE slug=NEW.slug AND account_id!=NEW.id)
BEGIN SELECT RAISE(ABORT, 'account_name_reserved'); END;

CREATE TRIGGER users_last_mfa_owner BEFORE UPDATE OF mfa_required ON users
WHEN OLD.mfa_required=1 AND NEW.mfa_required=0 AND EXISTS (
  SELECT 1 FROM memberships mine JOIN accounts a ON a.id=mine.account_id JOIN account_policies p ON p.account_id=a.id
  WHERE mine.principal_id=OLD.id AND mine.role_id='owner' AND mine.state='active' AND a.disabled_at IS NULL
    AND json_extract(p.config_json,'$.require_mfa')=1 AND NOT EXISTS (
      SELECT 1 FROM memberships m JOIN users u ON u.id=m.principal_id JOIN principals pr ON pr.id=u.id
      WHERE m.account_id=mine.account_id AND m.role_id='owner' AND m.state='active' AND m.principal_id!=OLD.id
        AND u.disabled_at IS NULL AND pr.disabled_at IS NULL AND u.email_verified_at IS NOT NULL AND u.mfa_required=1
        AND (EXISTS (SELECT 1 FROM passkeys k WHERE k.user_id=u.id) OR EXISTS (SELECT 1 FROM user_mfa f WHERE f.user_id=u.id AND f.enabled_at IS NOT NULL))
    )
)
BEGIN SELECT RAISE(ABORT, 'last_recoverable_owner'); END;

CREATE TRIGGER passkeys_last_mfa_factor BEFORE DELETE ON passkeys
WHEN EXISTS (SELECT 1 FROM users WHERE id=OLD.user_id AND mfa_required=1)
 AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id=OLD.user_id AND id!=OLD.id)
 AND NOT EXISTS (SELECT 1 FROM user_mfa WHERE user_id=OLD.user_id AND enabled_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'last_authenticator'); END;
