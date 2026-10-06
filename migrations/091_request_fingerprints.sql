-- API identity-keyring IDs are immutable versions. Copy both fingerprint fields
-- with a request during shard/cell movement; never re-key an existing operation.
ALTER TABLE idempotency_keys ADD COLUMN fingerprint_version INTEGER NOT NULL DEFAULT 0 CHECK (fingerprint_version >= 0);
ALTER TABLE idempotency_keys ADD COLUMN fingerprint_key_id TEXT
  CHECK (fingerprint_version = 0 OR (fingerprint_key_id IS NOT NULL AND length(fingerprint_key_id) BETWEEN 1 AND 32));

-- Old public digests permit offline guesses of low-entropy secret-write bodies.
-- SQL has no identity key and raw bodies are not retained, so retire those
-- fingerprints while preserving their operation references and deduplication
-- tombstones. Version zero is rejected, never compared or reexecuted.
UPDATE idempotency_keys SET request_hash=lower(hex(zeroblob(32))),response_body=NULL,response_headers_json=NULL
  WHERE fingerprint_version=0;

CREATE INDEX idempotency_fingerprint_retention ON idempotency_keys(fingerprint_key_id,expires_at,status);

-- Older writers must not recreate a public digest during a rolling rollout.
-- Zero-valued legacy tombstones remain insertable for repository moves/restores.
CREATE TRIGGER idempotency_fingerprint_protected_insert BEFORE INSERT ON idempotency_keys
WHEN NEW.response_body IS NOT NULL OR length(NEW.request_hash)<>64 OR NEW.request_hash GLOB '*[^0-9a-f]*'
  OR (NEW.fingerprint_version=0 AND NEW.request_hash<>lower(hex(zeroblob(32))))
BEGIN SELECT RAISE(ABORT,'unprotected_request_fingerprint'); END;
CREATE TRIGGER idempotency_fingerprint_protected_update BEFORE UPDATE OF request_hash,fingerprint_version,response_body ON idempotency_keys
WHEN NEW.response_body IS NOT NULL OR length(NEW.request_hash)<>64 OR NEW.request_hash GLOB '*[^0-9a-f]*'
  OR (NEW.fingerprint_version=0 AND NEW.request_hash<>lower(hex(zeroblob(32))))
BEGIN SELECT RAISE(ABORT,'unprotected_request_fingerprint'); END;

CREATE TRIGGER idempotency_fingerprint_immutable
BEFORE UPDATE OF request_hash,fingerprint_version,fingerprint_key_id ON idempotency_keys
WHEN OLD.fingerprint_version>0 AND (NEW.request_hash<>OLD.request_hash
  OR NEW.fingerprint_version<>OLD.fingerprint_version OR NEW.fingerprint_key_id IS NOT OLD.fingerprint_key_id)
BEGIN SELECT RAISE(ABORT,'idempotency_fingerprint_immutable'); END;
