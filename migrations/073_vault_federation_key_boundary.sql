-- The composed private Worker refuses an uninitialized key registry. These guards
-- additionally fence late cipher writes from an older rolling-deployment version.
CREATE TRIGGER federation_vault_key_guard BEFORE INSERT ON federation_client_secrets
WHEN EXISTS(SELECT 1 FROM vault_key_control WHERE id=1)
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM vault_key_control c JOIN vault_key_registry k ON k.id=c.active_key_id
    WHERE c.id=1 AND c.write_fenced=0 AND c.active_key_id=NEW.kek_id AND k.state='active') THEN 1
    ELSE RAISE(ABORT,'vault key write fenced') END;
END;
CREATE TRIGGER federation_vault_wrap_guard BEFORE INSERT ON federation_secret_wraps
WHEN EXISTS(SELECT 1 FROM vault_key_control WHERE id=1)
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM vault_key_control c JOIN vault_key_registry k ON k.id=c.active_key_id
    WHERE c.id=1 AND c.write_fenced=0 AND c.active_key_id=NEW.kek_id AND k.state='active') THEN 1
    ELSE RAISE(ABORT,'vault key write fenced') END;
END;
CREATE TRIGGER federation_vault_key_usage AFTER INSERT ON federation_client_secrets BEGIN
  UPDATE vault_key_registry SET wrap_count=wrap_count+1,last_wrapped_at=NEW.created_at WHERE id=NEW.kek_id;
  UPDATE vault_key_control SET catalog_revision=catalog_revision+1 WHERE id=1;
END;
CREATE TRIGGER federation_vault_wrap_usage AFTER INSERT ON federation_secret_wraps BEGIN
  UPDATE vault_key_registry SET wrap_count=wrap_count+1,last_wrapped_at=NEW.created_at WHERE id=NEW.kek_id;
END;
ALTER TABLE vault_recovery_verifications ADD COLUMN phase TEXT NOT NULL DEFAULT 'vault' CHECK(phase IN ('vault','federation'));
