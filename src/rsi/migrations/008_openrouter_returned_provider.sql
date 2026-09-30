ALTER TABLE headlesscode_rsi_inference_calls
	ADD COLUMN IF NOT EXISTS returned_provider text;
