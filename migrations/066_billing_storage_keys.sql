CREATE TABLE billing_storage_keys (
  bucket TEXT NOT NULL CHECK(bucket IN ('blobs','backups','snapshots')), object_key TEXT NOT NULL,
  account_id TEXT NOT NULL, object_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
  PRIMARY KEY(bucket,object_key)
);
