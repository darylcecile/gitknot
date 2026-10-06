-- Only the ordinary placement-local metadata fence guard emits -1. Preserve a
-- distinct transactional abort from credential/policy/revision/owner conflicts
-- so a request may defer its exact prepared batch without retrying other errors.
CREATE TRIGGER repository_metadata_fence_abort BEFORE INSERT ON mutation_guards
WHEN NEW.ok=-1
BEGIN SELECT RAISE(ABORT,'repository_metadata_fenced'); END;
