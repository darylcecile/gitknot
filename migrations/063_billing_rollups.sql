CREATE TABLE billing_usage_rollups (
  coordinator_id TEXT NOT NULL, account_id TEXT NOT NULL, period TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK(dimension IN ('account','repository','workflow','team','actor')),
  dimension_id TEXT NOT NULL, meter TEXT NOT NULL, operating_cost INTEGER NOT NULL CHECK(operating_cost IN (0,1)),
  quantity TEXT NOT NULL, amount_units TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(coordinator_id,account_id,period,dimension,dimension_id,meter,operating_cost)
);
CREATE INDEX billing_usage_period ON billing_usage_rollups(account_id,period,dimension,operating_cost,dimension_id,meter);
