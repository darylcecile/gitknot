ALTER TABLE invitations ADD COLUMN principal_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(principal_json));
