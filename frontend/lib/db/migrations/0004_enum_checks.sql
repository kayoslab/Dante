-- CHECK constraints on stable enum-shaped text columns. Adds runtime
-- protection against bad writes; doesn't change column type.
--
-- Existing values verified prior to applying:
--   freelancer.status  ∈ {active}
--   project.billing_model ∈ {fixed_price, time_and_material}
--   project.status ∈ {active, completed}
--   sync_run.status ∈ {running, completed, failed}

ALTER TABLE "freelancer"
  ADD CONSTRAINT "freelancer_status_check"
  CHECK (status IN ('active', 'inactive'));
--> statement-breakpoint
ALTER TABLE "project"
  ADD CONSTRAINT "project_billing_model_check"
  CHECK (billing_model IN ('time_and_material', 'fixed_price'));
--> statement-breakpoint
ALTER TABLE "project"
  ADD CONSTRAINT "project_status_check"
  CHECK (status IN ('active', 'completed', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "sync_run"
  ADD CONSTRAINT "sync_run_status_check"
  CHECK (status IN ('running', 'completed', 'failed', 'partial'));
