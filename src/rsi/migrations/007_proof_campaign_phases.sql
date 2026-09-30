ALTER TABLE headlesscode_rsi_proof_campaign_arms
	ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'development'
	CHECK (phase IN ('development','confirmation'));
