CREATE TABLE IF NOT EXISTS headlesscode_rsi_inference_campaigns (
	campaign_id text PRIMARY KEY,
	provider text NOT NULL CHECK (provider = 'openrouter'),
	model text NOT NULL,
	max_spend_microusd bigint NOT NULL CHECK (max_spend_microusd > 0),
	reserved_spend_microusd bigint NOT NULL DEFAULT 0 CHECK (reserved_spend_microusd >= 0),
	spent_microusd bigint NOT NULL DEFAULT 0 CHECK (spent_microusd >= 0),
	blocked boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS headlesscode_rsi_inference_jobs (
	job_id uuid PRIMARY KEY REFERENCES headlesscode_rsi_jobs(job_id) ON DELETE CASCADE,
	campaign_id text NOT NULL REFERENCES headlesscode_rsi_inference_campaigns(campaign_id),
	provider text NOT NULL CHECK (provider = 'openrouter'),
	model text NOT NULL,
	limits jsonb NOT NULL,
	lease_token_sha256 text NOT NULL CHECK (lease_token_sha256 ~ '^[a-f0-9]{64}$'),
	capability_sha256 text NOT NULL CHECK (capability_sha256 ~ '^[a-f0-9]{64}$'),
	max_spend_microusd bigint NOT NULL CHECK (max_spend_microusd > 0),
	reserved_spend_microusd bigint NOT NULL DEFAULT 0 CHECK (reserved_spend_microusd >= 0),
	spent_microusd bigint NOT NULL DEFAULT 0 CHECK (spent_microusd >= 0),
	max_calls integer NOT NULL CHECK (max_calls > 0),
	call_count integer NOT NULL DEFAULT 0 CHECK (call_count >= 0),
	max_tokens bigint NOT NULL CHECK (max_tokens > 0),
	reserved_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
	used_tokens bigint NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
	max_duration_ms integer NOT NULL CHECK (max_duration_ms > 0),
	started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	blocked boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS headlesscode_rsi_inference_calls (
	job_id uuid NOT NULL REFERENCES headlesscode_rsi_inference_jobs(job_id) ON DELETE CASCADE,
	call_id text NOT NULL,
	capability_sha256 text NOT NULL CHECK (capability_sha256 ~ '^[a-f0-9]{64}$'),
	request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
	state text NOT NULL CHECK (state IN ('reserved','complete','unmeasured')),
	reserved_spend_microusd bigint NOT NULL CHECK (reserved_spend_microusd > 0),
	reserved_tokens bigint NOT NULL CHECK (reserved_tokens > 0),
	actual_spend_microusd bigint,
	qualified boolean NOT NULL DEFAULT false,
	prompt_tokens bigint,
	completion_tokens bigint,
	returned_model text,
	provider_request_id text,
	response_sha256 text CHECK (response_sha256 IS NULL OR response_sha256 ~ '^[a-f0-9]{64}$'),
	started_at timestamptz NOT NULL,
	completed_at timestamptz,
	PRIMARY KEY (job_id, call_id),
	CHECK (actual_spend_microusd IS NULL OR actual_spend_microusd >= 0),
	CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
	CHECK (completion_tokens IS NULL OR completion_tokens >= 0)
);

CREATE INDEX IF NOT EXISTS headlesscode_rsi_inference_calls_campaign_idx
	ON headlesscode_rsi_inference_jobs(campaign_id);
