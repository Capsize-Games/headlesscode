ALTER TABLE headlesscode_rsi_inference_jobs
	ADD COLUMN IF NOT EXISTS endpoint_price jsonb;
