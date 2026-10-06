CREATE TABLE billing_storage_deletion_requests (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, repo_id TEXT, object_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL, fence TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('retention','funding')),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','financially_deleted','cancelled')),
  requested_at TEXT NOT NULL, delete_after TEXT NOT NULL, revision INTEGER NOT NULL
);
CREATE UNIQUE INDEX billing_deletion_request_live ON billing_storage_deletion_requests(account_id,object_id,reservation_id,fence,delete_after)
  WHERE state IN ('pending','claimed');
CREATE INDEX billing_deletion_requests_due ON billing_storage_deletion_requests(state,requested_at,id);
