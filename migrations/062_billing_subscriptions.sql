CREATE TABLE billing_subscription_changes (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES billing_accounts(account_id),
  previous_plan_id TEXT NOT NULL REFERENCES billing_plans(id), plan_id TEXT NOT NULL REFERENCES billing_plans(id),
  effective_at TEXT NOT NULL, actor_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(account_id, id)
);
CREATE TABLE billing_invoices (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES billing_accounts(account_id),
  period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','open','paid','void','uncollectible')),
  currency TEXT NOT NULL CHECK(currency='USD'), subtotal_units TEXT NOT NULL,
  credit_applied_units TEXT NOT NULL, payable_units TEXT NOT NULL, rounded_units TEXT NOT NULL,
  processor_amount_cents TEXT NOT NULL, rounding_carry_units TEXT NOT NULL,
  processor_payment_id TEXT, collection_method TEXT NOT NULL, issued_at TEXT NOT NULL,
  due_at TEXT NOT NULL, paid_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(account_id,period_start,period_end)
);
CREATE INDEX billing_invoices_account ON billing_invoices(account_id,issued_at,id);
CREATE TABLE billing_invoice_entries (
  invoice_id TEXT NOT NULL REFERENCES billing_invoices(id), ledger_id TEXT NOT NULL REFERENCES billing_ledger(id),
  PRIMARY KEY(invoice_id,ledger_id), UNIQUE(ledger_id)
);
CREATE TABLE billing_invoice_lines (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES billing_invoices(id), description TEXT NOT NULL,
  quantity TEXT NOT NULL, amount_units TEXT NOT NULL, price_version TEXT NOT NULL, kind TEXT NOT NULL
);
CREATE TABLE billing_credits (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES billing_accounts(account_id),
  amount_units TEXT NOT NULL, remaining_units TEXT NOT NULL, reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('included','operator','processor','refund')),
  source_id TEXT NOT NULL, expires_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, actor_id TEXT NOT NULL, UNIQUE(account_id,source,source_id)
);
CREATE INDEX billing_credits_account ON billing_credits(account_id,created_at,id);
CREATE TABLE billing_credit_applications (
  invoice_id TEXT NOT NULL REFERENCES billing_invoices(id), credit_id TEXT NOT NULL REFERENCES billing_credits(id),
  amount_units TEXT NOT NULL, PRIMARY KEY(invoice_id,credit_id)
);
CREATE TABLE billing_seat_reservations (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES billing_accounts(account_id),
  principal_id TEXT NOT NULL, additional_seats INTEGER NOT NULL CHECK(additional_seats>0),
  plan_id TEXT NOT NULL REFERENCES billing_plans(id), subscription_revision INTEGER NOT NULL,
  amount_units TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','consumed','cancelled')),
  request_hash TEXT NOT NULL, created_at TEXT NOT NULL, consumed_at TEXT, revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX billing_seats_account ON billing_seat_reservations(account_id,state,id);
CREATE TABLE billing_payment_events (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES billing_invoices(id), account_id TEXT NOT NULL,
  processor_event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, amount_cents TEXT NOT NULL,
  request_hash TEXT NOT NULL, occurred_at TEXT NOT NULL
);
