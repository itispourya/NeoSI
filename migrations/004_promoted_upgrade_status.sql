-- Keep the evolution status constraint compatible with promoted candidate modules.
-- This also upgrades databases that already applied 001_init.sql before 'promoted' existed.
ALTER TABLE self_upgrades
  DROP CONSTRAINT IF EXISTS self_upgrades_status_check;

ALTER TABLE self_upgrades
  ADD CONSTRAINT self_upgrades_status_check
  CHECK (status IN ('proposed', 'sandbox_passed', 'approved', 'promoted', 'merged', 'rejected', 'rolled_back'));
