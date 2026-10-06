-- Monetary values and quantities are canonical decimal TEXT; arithmetic is BigInt in the account coordinator.
CREATE TABLE billing_prices (
  id TEXT PRIMARY KEY, meter TEXT NOT NULL, meter_version INTEGER NOT NULL CHECK (meter_version > 0),
  version TEXT NOT NULL, currency TEXT NOT NULL CHECK (currency = 'USD'), unit_name TEXT NOT NULL,
  unit_quantity TEXT NOT NULL CHECK (unit_quantity <> '0' AND unit_quantity NOT GLOB '*[^0-9]*'),
  unit_price_units TEXT NOT NULL CHECK (unit_price_units <> '' AND unit_price_units NOT GLOB '*[^0-9]*'),
  platform_unit_price_units TEXT NOT NULL CHECK (platform_unit_price_units <> '' AND platform_unit_price_units NOT GLOB '*[^0-9]*'),
  created_at TEXT NOT NULL, UNIQUE (meter, version)
);
CREATE TRIGGER billing_prices_immutable_update BEFORE UPDATE ON billing_prices BEGIN SELECT RAISE(ABORT, 'immutable price'); END;
CREATE TRIGGER billing_prices_immutable_delete BEFORE DELETE ON billing_prices BEGIN SELECT RAISE(ABORT, 'immutable price'); END;

INSERT INTO billing_prices VALUES
 ('price_hosted_small_202610','hosted.linux-small',1,'2026-10-04','USD','runner-millisecond','60000','6000000','2500000','2026-10-04T00:00:00.000Z'),
 ('price_hosted_medium_202610','hosted.linux-medium',1,'2026-10-04','USD','runner-millisecond','60000','12000000','5000000','2026-10-04T00:00:00.000Z'),
 ('price_hosted_large_202610','hosted.linux-large',1,'2026-10-04','USD','runner-millisecond','60000','18000000','7500000','2026-10-04T00:00:00.000Z'),
 ('price_customer_runner_202610','self_hosted',1,'2026-10-04','USD','customer-runner-millisecond','1','0','0','2026-10-04T00:00:00.000Z'),
 ('price_blob_storage_202610','storage.blobs',1,'2026-10-04','USD','byte-millisecond','2592000000000000000','30000000','15000000','2026-10-04T00:00:00.000Z'),
 ('price_egress_202610','execution.egress',1,'2026-10-04','USD','byte','1000000000','100000000','100000000','2026-10-04T00:00:00.000Z');

CREATE TABLE billing_plans (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, currency TEXT NOT NULL CHECK (currency = 'USD'),
  monthly_base_units TEXT NOT NULL, seat_units TEXT NOT NULL, included_usage_units TEXT NOT NULL,
  default_budget_units TEXT NOT NULL, max_concurrency INTEGER NOT NULL CHECK (max_concurrency > 0),
  max_storage_bytes TEXT NOT NULL, max_seats INTEGER NOT NULL CHECK (max_seats > 0),
  entitlements_json TEXT NOT NULL CHECK (json_valid(entitlements_json)), created_at TEXT NOT NULL
);
INSERT INTO billing_plans VALUES
 ('plan_free_202610','Free','2026-10-04','USD','0','0','500000000','500000000',1,'2000000000',5,'{"hosted":true,"self_hosted":true,"maximum_duration_ms":1800000,"maximum_retention_seconds":7776000,"maximum_objects":8192,"maximum_egress_bytes":"1000000000"}','2026-10-04T00:00:00.000Z'),
 ('plan_pro_202610','Pro','2026-10-04','USD','9000000000','0','3000000000','25000000000',4,'50000000000',10,'{"hosted":true,"self_hosted":true,"maximum_duration_ms":7200000,"maximum_retention_seconds":7776000,"maximum_objects":8192,"maximum_egress_bytes":"10000000000"}','2026-10-04T00:00:00.000Z'),
 ('plan_team_202610','Team','2026-10-04','USD','0','12000000000','10000000000','100000000000',16,'500000000000',10000,'{"hosted":true,"self_hosted":true,"maximum_duration_ms":14400000,"maximum_retention_seconds":31536000,"maximum_objects":8192,"maximum_egress_bytes":"100000000000"}','2026-10-04T00:00:00.000Z');
CREATE TRIGGER billing_plans_immutable_update BEFORE UPDATE ON billing_plans BEGIN SELECT RAISE(ABORT, 'immutable plan'); END;
CREATE TRIGGER billing_plans_immutable_delete BEFORE DELETE ON billing_plans BEGIN SELECT RAISE(ABORT, 'immutable plan'); END;

CREATE TABLE billing_accounts (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id), plan_id TEXT NOT NULL REFERENCES billing_plans(id),
  state TEXT NOT NULL CHECK (state IN ('active','past_due','suspended','cancelled')),
  collection_method TEXT NOT NULL CHECK (collection_method IN ('manual','processor')),
  period_start TEXT NOT NULL, period_end TEXT NOT NULL, billing_email TEXT,
  seat_count INTEGER NOT NULL DEFAULT 1 CHECK (seat_count >= 0), rounding_carry_units TEXT NOT NULL DEFAULT '0',
  admission_epoch INTEGER NOT NULL DEFAULT 0, admission_initialized_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE billing_platform_pools (
  id TEXT PRIMARY KEY, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  limit_units TEXT NOT NULL, safety_buffer_units TEXT NOT NULL, baseline_commitment_units TEXT NOT NULL,
  allocated_units TEXT NOT NULL DEFAULT '0', max_instances INTEGER NOT NULL CHECK (max_instances >= 0),
  allocated_instances INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK (state IN ('active','stopped')),
  revision INTEGER NOT NULL DEFAULT 1,
  purpose TEXT NOT NULL DEFAULT 'discretionary' CHECK(purpose IN ('discretionary','essential'))
);
CREATE TABLE billing_capacity_slices (
  id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES billing_platform_pools(id), cell_id TEXT NOT NULL,
  limit_units TEXT NOT NULL, max_instances INTEGER NOT NULL CHECK (max_instances >= 0),
  max_storage_bytes TEXT NOT NULL, valid_until TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','stopped','retired')), admission_epoch INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'discretionary' CHECK(purpose IN ('discretionary','essential'))
);
CREATE INDEX billing_slices_pool ON billing_capacity_slices(pool_id, state, id);
CREATE TABLE billing_write_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK (valid = 1));
