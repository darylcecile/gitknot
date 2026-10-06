-- This credentialless service is an internal metadata authority, not a public
-- repository grant. Public APIs cannot authenticate as it. Core identity guards
-- still verify that it exists and has not been disabled at every maintenance CAS.
INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at)
VALUES ('acc_collaboration_system','organization','gitknot-collaboration-maintenance','GitKnot collaboration authority',NULL,
  '2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z');
INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at)
VALUES ('svc_collaboration_maintenance','service',NULL,'acc_collaboration_system','Collaboration maintenance',
  'system:platform','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z');
-- Retention operation attribution is consumed by the lifecycle worker's bounded
-- maintenance validator. It is not the SQL bookkeeping identity above.
INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at)
VALUES ('system:collaboration-retention','service',NULL,NULL,'Collaboration retention',
  'system:platform','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z');

CREATE TABLE collaboration_attachment_sagas (
  operation_id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL,
  object_id TEXT NOT NULL REFERENCES object_manifests(id) DEFERRABLE INITIALLY DEFERRED,
  repo_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  action TEXT NOT NULL CHECK (action IN ('create','prepare','complete','delete')),
  request_hash TEXT NOT NULL,
  initial_revision INTEGER NOT NULL,
  upload_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id,item_id,attachment_id) REFERENCES collaboration_attachments(repo_id,item_id,id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX collaboration_attachment_saga_object ON collaboration_attachment_sagas(object_id,created_at);

CREATE TABLE collaboration_attachment_cleanup (
  object_id TEXT PRIMARY KEY REFERENCES object_manifests(id),
  attachment_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('parent_deleted','expired','admission_cancelled')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','blocked','completed')),
  last_error TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id,item_id,attachment_id) REFERENCES collaboration_attachments(repo_id,item_id,id)
);
CREATE INDEX collaboration_attachment_cleanup_pending ON collaboration_attachment_cleanup(state,updated_at,object_id);

-- Stack ancestry is separate from the target-relative patch that reviewers see.
ALTER TABLE pull_dependencies ADD COLUMN base_oid TEXT;
ALTER TABLE pull_reviews ADD COLUMN submitted_revision INTEGER NOT NULL DEFAULT 0;
CREATE INDEX pull_reviews_submission ON pull_reviews(repo_id,pull_id,reviewer_id,submitted_revision DESC);
