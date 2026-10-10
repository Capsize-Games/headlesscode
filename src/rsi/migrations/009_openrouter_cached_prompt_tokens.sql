ALTER TABLE headlesscode_rsi_inference_calls
	ADD COLUMN IF NOT EXISTS cached_prompt_tokens bigint CHECK (cached_prompt_tokens IS NULL OR cached_prompt_tokens >= 0);
