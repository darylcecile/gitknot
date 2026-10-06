-- Operating bounds, not invented provider CPU/storage measurements. Currency is nano-USD.
INSERT INTO billing_prices VALUES
 ('price_git_helper_standard2_v1','git.helper.standard-2',1,'2026-10-05','USD','helper-millisecond-bound','1000','0','40000','2026-10-05T00:00:00.000Z'),
 ('price_git_helper_egress_v1','git.helper.egress',1,'2026-10-05','USD','metered-egress-byte-bound','1000000000','0','50000000','2026-10-05T00:00:00.000Z'),
 ('price_git_helper_operations_v1','git.helper.operations',1,'2026-10-05','USD','reserved-operation-bound','1000','0','150000000','2026-10-05T00:00:00.000Z'),
 ('price_git_logical_storage_v1','git.storage.logical',1,'2026-10-05','USD','logical-reachable-byte-millisecond','2592000000000000000','500000000','0','2026-10-05T00:00:00.000Z'),
 ('price_git_peak_storage_v1','git.storage.daily-peak-bound',1,'2026-10-05','USD','retained-bound-byte-day','30000000000','0','500000000','2026-10-05T00:00:00.000Z');

CREATE TABLE billing_helper_profiles (
  id TEXT NOT NULL, version TEXT NOT NULL, vcpu INTEGER NOT NULL, memory_mib INTEGER NOT NULL, disk_mb INTEGER NOT NULL,
  maximum_duration_ms INTEGER NOT NULL, maximum_egress_bytes TEXT NOT NULL, maximum_operations INTEGER NOT NULL,
  compute_price_id TEXT NOT NULL REFERENCES billing_prices(id), egress_price_id TEXT NOT NULL REFERENCES billing_prices(id),
  operations_price_id TEXT NOT NULL REFERENCES billing_prices(id), PRIMARY KEY(id,version)
);
INSERT INTO billing_helper_profiles VALUES ('standard-2','2026-10-05',1,6144,12000,330000,'4294967296',100000,
 'price_git_helper_standard2_v1','price_git_helper_egress_v1','price_git_helper_operations_v1');
CREATE TRIGGER billing_helper_profile_immutable BEFORE UPDATE ON billing_helper_profiles BEGIN SELECT RAISE(ABORT,'immutable helper profile'); END;
CREATE TRIGGER billing_helper_profile_immutable_delete BEFORE DELETE ON billing_helper_profiles BEGIN SELECT RAISE(ABORT,'immutable helper profile'); END;

CREATE TABLE billing_helper_intents (
  allocation_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE, slice_id TEXT NOT NULL, service TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)), quote_json TEXT NOT NULL CHECK(json_valid(quote_json)), request_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE billing_helper_allocations (
  reservation_id TEXT PRIMARY KEY, allocation_id TEXT NOT NULL UNIQUE, slice_id TEXT NOT NULL,
  state TEXT NOT NULL, body_json TEXT NOT NULL CHECK(json_valid(body_json)), revision INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE billing_git_intents (
  repo_id TEXT NOT NULL, operation_id TEXT NOT NULL, account_id TEXT NOT NULL, reservation_id TEXT NOT NULL UNIQUE,
  slice_id TEXT NOT NULL, fence TEXT NOT NULL, request_hash TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  created_at TEXT NOT NULL, quote_json TEXT CHECK(quote_json IS NULL OR json_valid(quote_json)), PRIMARY KEY(repo_id,operation_id)
);
CREATE TABLE billing_git_operations (
  coordinator_id TEXT NOT NULL, reservation_id TEXT NOT NULL, account_id TEXT NOT NULL, repo_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  state TEXT NOT NULL, body_json TEXT NOT NULL CHECK(json_valid(body_json)), revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(coordinator_id,reservation_id)
);
CREATE INDEX billing_git_operations_pending ON billing_git_operations(account_id,state,repo_id);
CREATE TABLE billing_git_repositories (
  coordinator_id TEXT NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL, repo_id TEXT NOT NULL, storage_name TEXT NOT NULL,
  logical_bytes TEXT NOT NULL, retained_bound_bytes TEXT NOT NULL, funded_until TEXT NOT NULL, accrued_at TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK(json_valid(body_json)), revision INTEGER NOT NULL,
  PRIMARY KEY(coordinator_id,id)
);
CREATE INDEX billing_git_repositories_account ON billing_git_repositories(account_id,repo_id);
CREATE TABLE billing_git_rejections (
  repo_id TEXT NOT NULL, operation_id TEXT NOT NULL, account_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
  proof TEXT NOT NULL CHECK(proof IN ('not_started','report_status')), effective_at TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(repo_id,operation_id)
);
CREATE TABLE billing_git_receipts (
  repo_id TEXT NOT NULL, operation_id TEXT NOT NULL, account_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
  receipt_hash TEXT NOT NULL, effective_at TEXT NOT NULL, source_revision INTEGER NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  PRIMARY KEY(repo_id,operation_id)
);
CREATE TRIGGER billing_git_receipt_immutable BEFORE UPDATE ON billing_git_receipts BEGIN SELECT RAISE(ABORT,'immutable publication receipt'); END;
CREATE TRIGGER billing_git_rejection_immutable BEFORE UPDATE ON billing_git_rejections BEGIN SELECT RAISE(ABORT,'immutable rejection receipt'); END;
CREATE TRIGGER billing_helper_intent_immutable BEFORE UPDATE ON billing_helper_intents BEGIN SELECT RAISE(ABORT,'immutable helper intent'); END;
CREATE TRIGGER billing_git_quote_immutable BEFORE UPDATE ON billing_git_intents WHEN OLD.quote_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable Git quote'); END;
CREATE TABLE billing_git_purges (
  repo_id TEXT NOT NULL, storage_name TEXT NOT NULL, operation_id TEXT NOT NULL, confirmed_at TEXT NOT NULL,
  source_confirmed_at TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), PRIMARY KEY(repo_id,storage_name)
);
CREATE TRIGGER billing_git_purge_immutable BEFORE UPDATE ON billing_git_purges BEGIN SELECT RAISE(ABORT,'immutable Git purge receipt'); END;
CREATE TABLE billing_git_transfers (
  operation_id TEXT NOT NULL REFERENCES billing_storage_handoffs(operation_id), repo_id TEXT NOT NULL, storage_name TEXT NOT NULL,
  from_account_id TEXT NOT NULL, to_account_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('preparing','prepared','complete','aborted')),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)), target_json TEXT CHECK(target_json IS NULL OR json_valid(target_json)),
  effective_at TEXT, PRIMARY KEY(operation_id,storage_name)
);
