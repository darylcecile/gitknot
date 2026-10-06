CREATE TABLE email_status_sources (
  id TEXT PRIMARY KEY,
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed')),
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX email_status_sources_pending ON email_status_sources(state,received_at,id);

-- Both notification management surfaces share one effective digest setting and revision barrier.
CREATE TRIGGER email_preferences_digest_insert AFTER INSERT ON email_preferences BEGIN
  INSERT INTO collaboration_profile_preferences(user_id,digest,created_at,updated_at)
    VALUES(new.user_id,new.digest,new.updated_at,new.updated_at)
    ON CONFLICT(user_id) DO UPDATE SET digest=excluded.digest,revision=revision+1,updated_at=excluded.updated_at WHERE digest<>excluded.digest;
END;
CREATE TRIGGER email_preferences_digest_update AFTER UPDATE OF digest ON email_preferences WHEN old.digest<>new.digest BEGIN
  UPDATE collaboration_profile_preferences SET digest=new.digest,revision=revision+1,updated_at=new.updated_at WHERE user_id=new.user_id AND digest<>new.digest;
END;
CREATE TRIGGER collaboration_email_digest_update AFTER UPDATE OF digest ON collaboration_profile_preferences WHEN old.digest<>new.digest BEGIN
  UPDATE email_preferences SET digest=new.digest,revision=revision+1,updated_at=new.updated_at WHERE user_id=new.user_id AND digest<>new.digest;
END;
