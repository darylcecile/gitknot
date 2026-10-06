CREATE TABLE billing_storage_placements (
  operation_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, account_id TEXT NOT NULL, state TEXT NOT NULL,
  request_hash TEXT NOT NULL, body_json TEXT NOT NULL CHECK(json_valid(body_json)), revision INTEGER NOT NULL
);
CREATE UNIQUE INDEX billing_storage_placement_live ON billing_storage_placements(repo_id) WHERE state NOT IN ('complete','aborted');
CREATE TRIGGER billing_storage_placement_identity BEFORE UPDATE ON billing_storage_placements
WHEN NEW.operation_id<>OLD.operation_id OR NEW.repo_id<>OLD.repo_id OR NEW.account_id<>OLD.account_id OR NEW.request_hash<>OLD.request_hash
  OR json_extract(NEW.body_json,'$.fence')<>json_extract(OLD.body_json,'$.fence')
  OR json_extract(NEW.body_json,'$.source_storage_name')<>json_extract(OLD.body_json,'$.source_storage_name')
  OR json_extract(NEW.body_json,'$.target_storage_name')<>json_extract(OLD.body_json,'$.target_storage_name')
  OR json_remove(NEW.body_json,'$.state','$.effective_at','$.revision')<>json_remove(OLD.body_json,'$.state','$.effective_at','$.revision')
  OR (json_extract(OLD.body_json,'$.effective_at') IS NOT NULL AND json_extract(NEW.body_json,'$.effective_at') IS NOT json_extract(OLD.body_json,'$.effective_at'))
BEGIN SELECT RAISE(ABORT,'immutable placement identity'); END;
CREATE TABLE billing_placement_copies (
  operation_id TEXT NOT NULL REFERENCES billing_storage_placements(operation_id), object_id TEXT NOT NULL,
  copy_id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  PRIMARY KEY(operation_id,object_id)
);
CREATE TABLE billing_placement_git (
  operation_id TEXT PRIMARY KEY REFERENCES billing_storage_placements(operation_id), body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  source_verified_json TEXT CHECK(source_verified_json IS NULL OR json_valid(source_verified_json)),
  target_verified_json TEXT CHECK(target_verified_json IS NULL OR json_valid(target_verified_json)),
  source_deleted_at TEXT, target_deleted_at TEXT
);
CREATE TRIGGER billing_placement_copy_identity BEFORE UPDATE ON billing_placement_copies
WHEN NEW.copy_id<>OLD.copy_id OR NEW.source_id<>OLD.source_id OR NEW.object_id<>OLD.object_id OR NEW.operation_id<>OLD.operation_id
  OR json_extract(NEW.body_json,'$.source')<>json_extract(OLD.body_json,'$.source') OR json_extract(NEW.body_json,'$.destination')<>json_extract(OLD.body_json,'$.destination')
  OR json_extract(NEW.body_json,'$.writer_id')<>json_extract(OLD.body_json,'$.writer_id')
  OR (json_type(OLD.body_json,'$.receipt')='object' AND json_extract(NEW.body_json,'$.receipt') IS NOT json_extract(OLD.body_json,'$.receipt'))
  OR (json_extract(OLD.body_json,'$.deleted_at') IS NOT NULL AND json_extract(NEW.body_json,'$.deleted_at') IS NOT json_extract(OLD.body_json,'$.deleted_at'))
BEGIN SELECT RAISE(ABORT,'immutable placement copy'); END;
CREATE TABLE billing_placement_receipts (
  operation_id TEXT NOT NULL, step TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,step)
);
CREATE TRIGGER billing_placement_receipt_immutable BEFORE UPDATE ON billing_placement_receipts BEGIN SELECT RAISE(ABORT,'immutable placement receipt'); END;
CREATE TRIGGER billing_placement_receipt_retained BEFORE DELETE ON billing_placement_receipts BEGIN SELECT RAISE(ABORT,'retained placement receipt'); END;
CREATE TABLE billing_placement_scratch (
  operation_id TEXT PRIMARY KEY REFERENCES billing_storage_placements(operation_id), object_key TEXT NOT NULL,
  bytes TEXT NOT NULL, checksum TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('writing','stored','deleted')),
  started_at TEXT NOT NULL, uploaded_at TEXT, deleted_at TEXT
);
