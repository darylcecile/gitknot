-- Keep federation assurance current without invalidating unrelated personal
-- sessions when ordinary memberships or team assignments change. Membership and
-- credential-scope checks still read current authoritative state on every use.
DROP TRIGGER federation_member_added;
DROP TRIGGER federation_member_changed;
DROP TRIGGER federation_member_removed;
DROP TRIGGER federation_team_member_added;
DROP TRIGGER federation_team_member_changed;
DROP TRIGGER federation_team_member_removed;

CREATE TRIGGER federation_member_added AFTER INSERT ON memberships
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=NEW.account_id;
  UPDATE credentials SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
   WHERE revoked_at IS NULL AND id IN (
     SELECT credential_id FROM federation_session_grants WHERE account_id=NEW.account_id AND user_id=NEW.principal_id
   );
  UPDATE federation_session_grants SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   WHERE account_id=NEW.account_id AND user_id=NEW.principal_id;
END;

CREATE TRIGGER federation_member_changed AFTER UPDATE OF role_id,state ON memberships
WHEN OLD.role_id<>NEW.role_id OR OLD.state<>NEW.state
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=NEW.account_id;
  UPDATE credentials SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),revision=revision+1
   WHERE revoked_at IS NULL AND (
     id IN (SELECT credential_id FROM federation_session_grants WHERE account_id=NEW.account_id AND user_id=NEW.principal_id)
     OR ((principal_id=NEW.principal_id OR user_id=NEW.principal_id OR created_by=NEW.principal_id) AND (
       EXISTS (SELECT 1 FROM json_each(credentials.account_ids_json) WHERE value=NEW.account_id)
       OR EXISTS (SELECT 1 FROM json_each(credentials.repository_ids_json) s JOIN repositories r ON r.id=s.value WHERE r.owner_id=NEW.account_id)
     ))
   );
  UPDATE federation_session_grants SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   WHERE account_id=NEW.account_id AND user_id=NEW.principal_id;
END;

CREATE TRIGGER federation_member_removed AFTER DELETE ON memberships
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=OLD.account_id;
  UPDATE credentials SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),revision=revision+1
   WHERE revoked_at IS NULL AND (
     id IN (SELECT credential_id FROM federation_session_grants WHERE account_id=OLD.account_id AND user_id=OLD.principal_id)
     OR ((principal_id=OLD.principal_id OR user_id=OLD.principal_id OR created_by=OLD.principal_id) AND (
       EXISTS (SELECT 1 FROM json_each(credentials.account_ids_json) WHERE value=OLD.account_id)
       OR EXISTS (SELECT 1 FROM json_each(credentials.repository_ids_json) s JOIN repositories r ON r.id=s.value WHERE r.owner_id=OLD.account_id)
     ))
   );
  UPDATE federation_session_grants SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   WHERE account_id=OLD.account_id AND user_id=OLD.principal_id;
END;

CREATE TRIGGER federation_team_member_added AFTER INSERT ON team_members
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=NEW.account_id;
  UPDATE credentials SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
   WHERE revoked_at IS NULL AND id IN (
     SELECT credential_id FROM federation_session_grants WHERE account_id=NEW.account_id AND user_id=NEW.principal_id
   );
  UPDATE federation_session_grants SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   WHERE account_id=NEW.account_id AND user_id=NEW.principal_id;
END;

CREATE TRIGGER federation_team_member_changed AFTER UPDATE OF role ON team_members
WHEN OLD.role<>NEW.role
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=NEW.account_id;
  UPDATE credentials SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
   WHERE revoked_at IS NULL AND (
     id IN (SELECT credential_id FROM federation_session_grants WHERE account_id=NEW.account_id AND user_id=NEW.principal_id)
     OR ((principal_id=NEW.principal_id OR user_id=NEW.principal_id OR created_by=NEW.principal_id) AND (
       EXISTS (SELECT 1 FROM json_each(credentials.account_ids_json) WHERE value=NEW.account_id)
       OR EXISTS (SELECT 1 FROM json_each(credentials.repository_ids_json) s JOIN repositories r ON r.id=s.value WHERE r.owner_id=NEW.account_id)
     ))
   );
  UPDATE federation_session_grants SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   WHERE account_id=NEW.account_id AND user_id=NEW.principal_id;
END;

CREATE TRIGGER federation_team_member_removed AFTER DELETE ON team_members
BEGIN
  UPDATE accounts SET policy_revision=policy_revision+1 WHERE id=OLD.account_id;
  UPDATE credentials SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
   WHERE revoked_at IS NULL AND (
     id IN (SELECT credential_id FROM federation_session_grants WHERE account_id=OLD.account_id AND user_id=OLD.principal_id)
     OR ((principal_id=OLD.principal_id OR user_id=OLD.principal_id OR created_by=OLD.principal_id) AND (
       EXISTS (SELECT 1 FROM json_each(credentials.account_ids_json) WHERE value=OLD.account_id)
       OR EXISTS (SELECT 1 FROM json_each(credentials.repository_ids_json) s JOIN repositories r ON r.id=s.value WHERE r.owner_id=OLD.account_id)
     ))
   );
  UPDATE federation_session_grants SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   WHERE account_id=OLD.account_id AND user_id=OLD.principal_id;
END;
