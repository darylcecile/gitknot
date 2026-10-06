CREATE INDEX outbox_committed_cursor ON outbox(created_at,id);
CREATE INDEX processed_events_source ON processed_events(event_id,consumer);
CREATE INDEX collaboration_inbox_event_delivery ON collaboration_inbox(source_event_id,id);
CREATE INDEX mail_provider_events_delivery ON mail_provider_events(delivery_id,id);
CREATE INDEX object_manifests_accrual ON object_manifests(state,storage_accrued_at,id);
CREATE INDEX object_manifests_key_scope ON object_manifests(object_key,repo_id,state);
CREATE INDEX git_lfs_object_key_scope ON git_lfs_objects(storage_key,state,repo_id);
CREATE UNIQUE INDEX event_replay_live_webhook ON event_replays(webhook_id) WHERE state IN ('pending','running');
