ALTER TABLE workflow_runs ADD COLUMN enqueue_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_promotions ADD COLUMN enqueue_sequence INTEGER NOT NULL DEFAULT 0;
CREATE INDEX workflow_runs_fifo ON workflow_runs(repo_id,concurrency_key,enqueue_sequence);
CREATE INDEX workflow_promotions_fifo ON workflow_promotions(repo_id,environment_id,status,enqueue_sequence);
