ALTER TABLE repository_transfers ADD COLUMN accepted_principal_json TEXT CHECK (accepted_principal_json IS NULL OR json_valid(accepted_principal_json));
ALTER TABLE repository_transfers ADD COLUMN destination_policy_revision INTEGER;

CREATE TABLE repository_name_reservations (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  slug TEXT NOT NULL COLLATE NOCASE,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  transfer_id TEXT NOT NULL REFERENCES repository_transfers(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, slug),
  UNIQUE (transfer_id)
);
CREATE TRIGGER repositories_name_reservation_insert BEFORE INSERT ON repositories
WHEN EXISTS (SELECT 1 FROM repository_name_reservations WHERE account_id=NEW.owner_id AND slug=NEW.slug AND repo_id!=NEW.id)
BEGIN SELECT RAISE(ABORT, 'repository_name_reserved'); END;
CREATE TRIGGER repositories_name_reservation_update BEFORE UPDATE OF owner_id, slug ON repositories
WHEN EXISTS (SELECT 1 FROM repository_name_reservations WHERE account_id=NEW.owner_id AND slug=NEW.slug AND repo_id!=NEW.id)
BEGIN SELECT RAISE(ABORT, 'repository_name_reserved'); END;
