CREATE TABLE IF NOT EXISTS headlesscode_rsi_proof_campaigns (
	campaign_id text PRIMARY KEY,
	schema_version integer NOT NULL CHECK (schema_version = 1),
	manifest jsonb NOT NULL,
	manifest_sha256 char(64) NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
	expected_arms jsonb NOT NULL CHECK (jsonb_typeof(expected_arms) = 'array'),
	state text NOT NULL CHECK (state IN ('planned','running','evaluated','selected','rejected','confirmed','finished')),
	sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
	deadline_at timestamptz NOT NULL,
	max_calls bigint NOT NULL CHECK (max_calls >= 0),
	max_tokens bigint NOT NULL CHECK (max_tokens >= 0),
	max_spend_microusd bigint NOT NULL CHECK (max_spend_microusd >= 0),
	reserved_calls bigint NOT NULL DEFAULT 0 CHECK (reserved_calls >= 0),
	reserved_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
	reserved_spend_microusd bigint NOT NULL DEFAULT 0 CHECK (reserved_spend_microusd >= 0),
	used_calls bigint NOT NULL DEFAULT 0 CHECK (used_calls >= 0),
	used_tokens bigint NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
	used_spend_microusd bigint NOT NULL DEFAULT 0 CHECK (used_spend_microusd >= 0),
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS headlesscode_rsi_proof_campaign_arms (
	campaign_id text NOT NULL REFERENCES headlesscode_rsi_proof_campaigns(campaign_id),
	arm_id text NOT NULL,
	run_id text NOT NULL,
	epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
	coordinator_id text,
	lease_token_sha256 char(64),
	lease_expires_at timestamptz,
	state text NOT NULL CHECK (state IN ('planned','running','evaluated','selected','rejected','confirmed','finished')),
	updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	PRIMARY KEY (campaign_id, arm_id),
	UNIQUE (campaign_id, run_id),
	CHECK ((coordinator_id IS NULL) = (lease_token_sha256 IS NULL)),
	CHECK ((coordinator_id IS NULL) = (lease_expires_at IS NULL))
);

CREATE TABLE IF NOT EXISTS headlesscode_rsi_proof_campaign_attempts (
	campaign_id text NOT NULL REFERENCES headlesscode_rsi_proof_campaigns(campaign_id),
	arm_id text NOT NULL,
	attempt_key text NOT NULL,
	attempt_kind text NOT NULL CHECK (attempt_kind IN ('mutation','development-proof','verification','confirmation','fixed-control')),
	generation integer NOT NULL CHECK (generation >= 0),
	candidate_id text NOT NULL,
	source_candidate_id text NOT NULL,
	task_id text NOT NULL,
	seed text NOT NULL,
	identity_sha256 char(64) NOT NULL CHECK (identity_sha256 ~ '^[a-f0-9]{64}$'),
	request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
	status text NOT NULL CHECK (status IN ('admitted','dispatched','completed','uncertain','failed','incomplete','skipped-after-hard-gate','not-selected')),
	epoch bigint NOT NULL CHECK (epoch > 0),
	job_id uuid,
	broker_job_id text,
	reserved_calls bigint NOT NULL CHECK (reserved_calls >= 0),
	reserved_tokens bigint NOT NULL CHECK (reserved_tokens >= 0),
	reserved_spend_microusd bigint NOT NULL CHECK (reserved_spend_microusd >= 0),
	actual_calls bigint,
	actual_tokens bigint,
	actual_spend_microusd bigint,
	result_sha256 char(64),
	artifact_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
	error text,
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	PRIMARY KEY (campaign_id, arm_id, attempt_key),
	UNIQUE (campaign_id, arm_id, generation, candidate_id, task_id, seed, attempt_kind),
	FOREIGN KEY (campaign_id, arm_id) REFERENCES headlesscode_rsi_proof_campaign_arms(campaign_id, arm_id),
	CHECK (actual_calls IS NULL OR actual_calls >= 0),
	CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
	CHECK (actual_spend_microusd IS NULL OR actual_spend_microusd >= 0),
	CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[a-f0-9]{64}$'),
	CHECK ((status = 'completed') = (result_sha256 IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS headlesscode_rsi_proof_campaign_decisions (
	campaign_id text NOT NULL,
	arm_id text NOT NULL,
	generation integer NOT NULL CHECK (generation >= 0),
	candidate_id text NOT NULL,
	parent_id text NOT NULL,
	lineage_kind text NOT NULL CHECK (lineage_kind IN ('root','root-restart','selected-parent','selected-ancestor')),
	parent_generation integer CHECK (parent_generation IS NULL OR (parent_generation >= 0 AND parent_generation < generation)),
	decision text NOT NULL CHECK (decision IN ('accepted','rejected','failed','incomplete')),
	child_commit text NOT NULL CHECK (child_commit ~ '^[a-f0-9]{40}$'),
	parent_commit text NOT NULL CHECK (parent_commit ~ '^[a-f0-9]{40}$'),
	proof jsonb NOT NULL,
	proof_sha256 char(64) NOT NULL CHECK (proof_sha256 ~ '^[a-f0-9]{64}$'),
	attempt_keys jsonb NOT NULL CHECK (jsonb_typeof(attempt_keys) = 'array'),
	epoch bigint NOT NULL CHECK (epoch > 0),
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	PRIMARY KEY (campaign_id, arm_id, candidate_id),
	FOREIGN KEY (campaign_id, arm_id) REFERENCES headlesscode_rsi_proof_campaign_arms(campaign_id, arm_id)
);

CREATE TABLE IF NOT EXISTS headlesscode_rsi_proof_campaign_events (
	campaign_id text NOT NULL REFERENCES headlesscode_rsi_proof_campaigns(campaign_id),
	sequence bigint NOT NULL CHECK (sequence > 0),
	arm_id text,
	epoch bigint,
	event_type text NOT NULL,
	payload jsonb NOT NULL,
	payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	PRIMARY KEY (campaign_id, sequence)
);

CREATE INDEX IF NOT EXISTS headlesscode_rsi_proof_attempt_status_idx
	ON headlesscode_rsi_proof_campaign_attempts(campaign_id, arm_id, status);
