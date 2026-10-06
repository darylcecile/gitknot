ALTER TABLE runners ADD COLUMN assignment_attempt_id TEXT;
ALTER TABLE runners ADD COLUMN disposable_consumed_at TEXT;
CREATE INDEX runners_disposable_assignment ON runners(assignment_attempt_id,disposable);
UPDATE runners SET assignment_attempt_id=(SELECT a.id FROM execution_attempts a WHERE a.runner_id=runners.id AND a.allocated_at IS NOT NULL ORDER BY a.created_at,a.id LIMIT 1),
  disposable_consumed_at=(SELECT MIN(a.allocated_at) FROM execution_attempts a WHERE a.runner_id=runners.id AND a.allocated_at IS NOT NULL)
WHERE disposable=1 AND assignment_attempt_id IS NULL;
