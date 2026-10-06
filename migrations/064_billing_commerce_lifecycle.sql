ALTER TABLE billing_accounts ADD COLUMN subscription_remainder TEXT NOT NULL DEFAULT '0';
ALTER TABLE billing_subscription_changes ADD COLUMN state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete'));
ALTER TABLE billing_subscription_changes ADD COLUMN previous_stopped INTEGER NOT NULL DEFAULT 0;
CREATE TABLE billing_plan_segments (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES billing_accounts(account_id),
  plan_id TEXT NOT NULL REFERENCES billing_plans(id), seat_count INTEGER NOT NULL CHECK(seat_count>=0),
  started_at TEXT NOT NULL, ended_at TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX billing_plan_segment_open ON billing_plan_segments(account_id) WHERE ended_at IS NULL;
CREATE INDEX billing_plan_segments_period ON billing_plan_segments(account_id,started_at,id);
CREATE TABLE billing_seat_events (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, principal_id TEXT NOT NULL, delta INTEGER NOT NULL,
  reservation_id TEXT, occurred_at TEXT NOT NULL, UNIQUE(account_id,principal_id,reservation_id)
);
CREATE TABLE billing_sweep_cursors (name TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at TEXT NOT NULL);
