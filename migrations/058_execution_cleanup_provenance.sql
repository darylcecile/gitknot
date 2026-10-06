ALTER TABLE execution_runtime_receipts ADD COLUMN proof_kind TEXT NOT NULL DEFAULT 'hosted_destroyed'
  CHECK(proof_kind IN ('hosted_destroyed','never_allocated'));
ALTER TABLE execution_objects ADD COLUMN source_size_bytes INTEGER CHECK(source_size_bytes IS NULL OR source_size_bytes>=0);
ALTER TABLE execution_attempts ADD COLUMN cleanup_lease_hash TEXT;
UPDATE execution_attempts SET cleanup_lease_hash=credential_hash WHERE allocated_at IS NOT NULL;
CREATE TRIGGER execution_cleanup_lease_immutable BEFORE UPDATE OF cleanup_lease_hash ON execution_attempts
WHEN OLD.cleanup_lease_hash IS NOT NULL AND NEW.cleanup_lease_hash IS NOT OLD.cleanup_lease_hash BEGIN
  SELECT RAISE(ABORT,'the original cleanup lease is immutable');
END;
