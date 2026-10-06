CREATE TABLE mail_fanouts (
  event_id TEXT PRIMARY KEY REFERENCES outbox(id),
  repo_id TEXT,
  authority TEXT NOT NULL CHECK(authority IN ('identity','repository')),
  recipient_count INTEGER NOT NULL CHECK(recipient_count>=0),
  created_at TEXT NOT NULL
);
CREATE TABLE mail_recipients (
  event_id TEXT NOT NULL REFERENCES mail_fanouts(event_id),
  delivery_id TEXT NOT NULL,
  user_id TEXT,
  account_id TEXT,
  repo_id TEXT,
  template TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','materialized')),
  PRIMARY KEY(event_id,delivery_id)
);
CREATE INDEX mail_recipients_pending ON mail_recipients(event_id,state,delivery_id);
ALTER TABLE mail_deliveries ADD COLUMN authorized_payload_sha256 TEXT;
ALTER TABLE mail_deliveries ADD COLUMN authorized_at TEXT;
