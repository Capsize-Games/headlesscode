ALTER TABLE headlesscode_rsi_jobs
	ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
	ADD COLUMN IF NOT EXISTS cancel_reason text;
