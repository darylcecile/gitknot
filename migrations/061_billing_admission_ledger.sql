CREATE TABLE billing_controls (
  coordinator_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body_json TEXT NOT NULL CHECK(json_valid(body_json)), updated_at TEXT NOT NULL
);
CREATE TABLE billing_budgets (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('account','repository','team','workflow','actor')),
  scope_id TEXT NOT NULL, limit_units TEXT NOT NULL, safety_buffer_units TEXT NOT NULL,
  settled_units TEXT NOT NULL DEFAULT '0', reserved_units TEXT NOT NULL DEFAULT '0', commitment_units TEXT NOT NULL DEFAULT '0',
  period_start TEXT NOT NULL, period_end TEXT, threshold_percentages_json TEXT NOT NULL DEFAULT '[50,80,100]',
  stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0,1)), revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX billing_budgets_account ON billing_budgets(account_id, id);
CREATE INDEX billing_budgets_scope ON billing_budgets(account_id, scope, scope_id);
CREATE TABLE billing_reservations (
  id TEXT NOT NULL, coordinator_id TEXT NOT NULL, account_id TEXT NOT NULL, repo_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, fence TEXT NOT NULL,
  maximum_charge_units TEXT NOT NULL, maximum_platform_units TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK(json_valid(body_json)), revision INTEGER NOT NULL,
  created_at TEXT NOT NULL, settled_at TEXT, PRIMARY KEY(coordinator_id,id),
  UNIQUE(coordinator_id,account_id,attempt_id,generation)
);
CREATE INDEX billing_reservations_open ON billing_reservations(account_id,state,created_at,id);
CREATE TABLE billing_ledger (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, account_id TEXT NOT NULL, repo_id TEXT,
  actor_id TEXT NOT NULL, workflow_id TEXT, team_id TEXT, run_id TEXT,
  attempt_id TEXT, generation INTEGER, reservation_id TEXT, object_id TEXT,
  kind TEXT NOT NULL, operating_cost INTEGER NOT NULL CHECK (operating_cost IN (0,1)),
  quantity TEXT NOT NULL, amount_units TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency='USD'),
  price_id TEXT NOT NULL REFERENCES billing_prices(id), price_version TEXT NOT NULL,
  meter TEXT NOT NULL, meter_version INTEGER NOT NULL, unit_price_units TEXT NOT NULL, unit_quantity TEXT NOT NULL,
  remainder_before TEXT NOT NULL, remainder_after TEXT NOT NULL, closing_remainder_before TEXT, closing_remainder_after TEXT,
  occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, evidence_id TEXT NOT NULL
);
CREATE INDEX billing_ledger_account ON billing_ledger(account_id, operating_cost, occurred_at, id);
CREATE INDEX billing_ledger_repo ON billing_ledger(account_id, repo_id, occurred_at, id);
CREATE INDEX billing_ledger_workflow ON billing_ledger(account_id, workflow_id, occurred_at, id);
CREATE INDEX billing_ledger_team ON billing_ledger(account_id, team_id, occurred_at, id);
CREATE INDEX billing_ledger_actor ON billing_ledger(account_id, actor_id, occurred_at, id);
CREATE TRIGGER billing_ledger_immutable_update BEFORE UPDATE ON billing_ledger BEGIN SELECT RAISE(ABORT, 'immutable ledger'); END;
CREATE TRIGGER billing_ledger_immutable_delete BEFORE DELETE ON billing_ledger BEGIN SELECT RAISE(ABORT, 'immutable ledger'); END;
CREATE TABLE billing_coordinator_events (
  id TEXT PRIMARY KEY, coordinator_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  payload_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(coordinator_id,sequence)
);
CREATE TABLE billing_storage_objects (
  id TEXT NOT NULL, coordinator_id TEXT NOT NULL, account_id TEXT NOT NULL, repo_id TEXT,
  reservation_id TEXT NOT NULL, object_key TEXT NOT NULL, bucket TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploading','stored','deleting','deleted','transferring','transfer_pending','transferred')),
  bytes TEXT NOT NULL, commitment_units TEXT NOT NULL, retention_until TEXT,
  commitment_until TEXT NOT NULL, accrued_at TEXT NOT NULL, deleted_at TEXT,
  body_json TEXT NOT NULL CHECK(json_valid(body_json)), revision INTEGER NOT NULL,
  PRIMARY KEY(coordinator_id,id)
);
CREATE INDEX billing_storage_physical ON billing_storage_objects(bucket,object_key,coordinator_id);
CREATE INDEX billing_storage_sweep ON billing_storage_objects(state, retention_until, id);
CREATE INDEX billing_storage_account ON billing_storage_objects(account_id, state, id);
CREATE TABLE billing_alerts (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, budget_id TEXT NOT NULL, budget_revision INTEGER NOT NULL,
  threshold INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(budget_id,budget_revision,threshold)
);
CREATE TABLE billing_reconciliations (
  id TEXT PRIMARY KEY, account_id TEXT, slice_id TEXT, source TEXT NOT NULL, source_event_id TEXT NOT NULL,
  period_start TEXT NOT NULL, period_end TEXT NOT NULL, amount_units TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), state TEXT NOT NULL CHECK(state IN ('pending','matched','discrepancy','resolved')),
  created_at TEXT NOT NULL, resolved_at TEXT, UNIQUE(source,source_event_id)
);
