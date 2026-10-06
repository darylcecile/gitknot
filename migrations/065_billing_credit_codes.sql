CREATE TABLE billing_credit_codes (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, account_id TEXT,
  amount_units TEXT NOT NULL, reason TEXT NOT NULL, expires_at TEXT NOT NULL,
  redeemed_by_account_id TEXT, redeemed_at TEXT, created_at TEXT NOT NULL, issued_by TEXT NOT NULL
);
CREATE TABLE billing_invoice_finalizations (
  invoice_id TEXT PRIMARY KEY REFERENCES billing_invoices(id), account_id TEXT NOT NULL,
  period_start TEXT NOT NULL, next_period_start TEXT NOT NULL, next_period_end TEXT NOT NULL,
  fixed_cost_units TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete'))
);
