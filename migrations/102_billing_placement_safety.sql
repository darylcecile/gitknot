-- Namespace ownership is independent of observing that a provider name exists.
CREATE TABLE billing_placement_namespaces (
  cell_id TEXT NOT NULL, storage_name TEXT NOT NULL, operation_id TEXT NOT NULL,
  repo_id TEXT NOT NULL, account_id TEXT NOT NULL, placement_fence TEXT NOT NULL,
  creation_marker TEXT NOT NULL UNIQUE, creation_receipt_json TEXT CHECK(creation_receipt_json IS NULL OR json_valid(creation_receipt_json)),
  state TEXT NOT NULL CHECK(state IN ('creating','owned','not_started','deleted')),
  absence_observed_at TEXT NOT NULL, owned_at TEXT, not_started_at TEXT, deleted_at TEXT,
  PRIMARY KEY(cell_id,storage_name), UNIQUE(operation_id)
);
CREATE TRIGGER billing_placement_namespace_identity BEFORE UPDATE ON billing_placement_namespaces
WHEN NEW.cell_id<>OLD.cell_id OR NEW.storage_name<>OLD.storage_name OR NEW.operation_id<>OLD.operation_id
  OR NEW.repo_id<>OLD.repo_id OR NEW.account_id<>OLD.account_id OR NEW.placement_fence<>OLD.placement_fence
  OR NEW.absence_observed_at<>OLD.absence_observed_at OR NEW.creation_marker<>OLD.creation_marker
  OR (OLD.creation_receipt_json IS NOT NULL AND NEW.creation_receipt_json IS NOT OLD.creation_receipt_json)
BEGIN SELECT RAISE(ABORT,'immutable placement namespace'); END;
CREATE TRIGGER billing_placement_namespace_retained BEFORE DELETE ON billing_placement_namespaces
BEGIN SELECT RAISE(ABORT,'retained placement namespace'); END;
CREATE TRIGGER billing_placement_namespace_terminal BEFORE UPDATE ON billing_placement_namespaces
WHEN (OLD.state IN ('not_started','deleted') AND NEW.state<>OLD.state)
  OR (OLD.state='owned' AND NEW.state NOT IN ('owned','deleted'))
  OR (OLD.owned_at IS NOT NULL AND NEW.owned_at IS NOT OLD.owned_at)
  OR (OLD.not_started_at IS NOT NULL AND NEW.not_started_at IS NOT OLD.not_started_at)
  OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at)
BEGIN SELECT RAISE(ABORT,'terminal placement namespace outcome'); END;

-- A positive native coordinator receipt survives removal of staged metadata.
CREATE TABLE billing_placement_publications (
  operation_id TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('source','target')), repo_id TEXT NOT NULL, placement_fence TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), recorded_at TEXT NOT NULL, PRIMARY KEY(operation_id,side)
);
CREATE TRIGGER billing_placement_publication_immutable BEFORE UPDATE ON billing_placement_publications
BEGIN SELECT RAISE(ABORT,'immutable placement publication'); END;
CREATE TRIGGER billing_placement_publication_retained BEFORE DELETE ON billing_placement_publications
BEGIN SELECT RAISE(ABORT,'retained placement publication'); END;
CREATE TABLE billing_placement_namespace_cleanup (
  operation_id TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('source','target')),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), recorded_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,side)
);
CREATE TRIGGER billing_placement_namespace_cleanup_immutable BEFORE UPDATE ON billing_placement_namespace_cleanup
BEGIN SELECT RAISE(ABORT,'immutable namespace cleanup'); END;
CREATE TRIGGER billing_placement_namespace_cleanup_retained BEFORE DELETE ON billing_placement_namespace_cleanup
BEGIN SELECT RAISE(ABORT,'retained namespace cleanup'); END;
