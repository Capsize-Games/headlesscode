ALTER TABLE headlesscode_rsi_jobs
	DROP CONSTRAINT IF EXISTS headlesscode_rsi_jobs_job_kind_check;

ALTER TABLE headlesscode_rsi_jobs
	ADD CONSTRAINT headlesscode_rsi_jobs_job_kind_check
	CHECK (job_kind IN ('mutation', 'evaluation', 'training', 'model-evaluation'));
