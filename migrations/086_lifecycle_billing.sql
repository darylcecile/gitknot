ALTER TABLE repository_transfers ADD COLUMN storage_effective_at TEXT;

INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at)
  VALUES('acc_operations_system','organization','gitknot-operations-maintenance','GitKnot operations authority',NULL,
    '2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z') ON CONFLICT(id) DO NOTHING;
INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at)
  VALUES('svc_operations_maintenance','service',NULL,'acc_operations_system','Operations maintenance','system:platform',
    '2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z') ON CONFLICT(id) DO NOTHING;

-- These principals have no user credentials, roles, or public grants. Their
-- bounded maintenance authority comes from validated durable operations.
INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at)
  VALUES('system:operations','service',NULL,NULL,'GitKnot repository maintenance','system:operations',
    '2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z') ON CONFLICT(id) DO NOTHING;
INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at)
  VALUES('system:collaboration-retention','service',NULL,NULL,'GitKnot workspace retention','system:operations',
    '2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z') ON CONFLICT(id) DO NOTHING;

INSERT INTO mutation_guards(id,ok)
  SELECT 'operations_system_principals',CASE WHEN
    EXISTS(SELECT 1 FROM principals WHERE id='system:operations' AND kind='service' AND user_id IS NULL AND account_id IS NULL)
    AND EXISTS(SELECT 1 FROM principals WHERE id='system:collaboration-retention' AND kind='service' AND user_id IS NULL AND account_id IS NULL)
    AND EXISTS(SELECT 1 FROM principals WHERE id='svc_operations_maintenance' AND kind='service' AND user_id IS NULL AND account_id='acc_operations_system')
    THEN 1 ELSE 0 END;
DELETE FROM mutation_guards WHERE id='operations_system_principals';

CREATE TABLE operations_maintenance_intents (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id) DEFERRABLE INITIALLY DEFERRED,
  repo_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('repository.backup','repository.purge','repository.move')),
  authority_id TEXT NOT NULL CHECK(authority_id='svc_operations_maintenance'),
  routing_epoch INTEGER NOT NULL CHECK(routing_epoch>0),
  repository_revision INTEGER NOT NULL CHECK(repository_revision>0),
  barrier_token_hash TEXT,
  barrier_held_at TEXT,
  barrier_released_at TEXT,
  created_at TEXT NOT NULL
);
