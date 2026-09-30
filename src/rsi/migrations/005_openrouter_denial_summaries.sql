ALTER TABLE headlesscode_rsi_inference_jobs
	ADD COLUMN IF NOT EXISTS denials jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE headlesscode_rsi_inference_jobs
	ADD CONSTRAINT headlesscode_rsi_inference_jobs_denials_object
	CHECK (jsonb_typeof(denials) = 'object');
