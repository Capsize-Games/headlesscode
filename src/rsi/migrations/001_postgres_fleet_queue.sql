CREATE TABLE IF NOT EXISTS headlesscode_rsi_queue_policy (
	queue_name text PRIMARY KEY,
	max_in_flight integer NOT NULL CHECK (max_in_flight > 0),
	lease_ms integer NOT NULL CHECK (lease_ms >= 1000),
	max_attempts integer NOT NULL CHECK (max_attempts > 0),
	class_capacity jsonb NOT NULL DEFAULT '{}'::jsonb,
	key_capacity jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS headlesscode_rsi_workers (
	queue_name text NOT NULL REFERENCES headlesscode_rsi_queue_policy(queue_name),
	worker_id text NOT NULL,
	gateway_id text NOT NULL,
	hostname text NOT NULL,
	max_active integer NOT NULL CHECK (max_active > 0),
	resource_classes jsonb NOT NULL DEFAULT '[]'::jsonb,
	active boolean NOT NULL DEFAULT true,
	registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	PRIMARY KEY(queue_name, worker_id)
);

CREATE TABLE IF NOT EXISTS headlesscode_rsi_artifacts (
	sha256 char(64) PRIMARY KEY,
	storage_id text NOT NULL,
	object_key text NOT NULL,
	backend text NOT NULL CHECK (backend IN ('s3', 'file')),
	byte_length bigint NOT NULL CHECK (byte_length > 0),
	created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS headlesscode_rsi_jobs (
	job_id uuid PRIMARY KEY,
	queue_name text NOT NULL REFERENCES headlesscode_rsi_queue_policy(queue_name),
	idempotency_key text NOT NULL,
	run_id text NOT NULL,
	candidate_id text NOT NULL,
	job_kind text NOT NULL CHECK (job_kind IN ('mutation', 'evaluation')),
	resource_class text NOT NULL CHECK (resource_class IN ('LOCAL_GPU', 'CPU', 'REMOTE_API', 'TRAINING_GPU')),
	concurrency_key text,
	artifact_sha256 char(64) NOT NULL REFERENCES headlesscode_rsi_artifacts(sha256),
	payload jsonb NOT NULL,
	status text NOT NULL CHECK (status IN ('queued', 'leased', 'completed', 'failed', 'cancelled')),
	attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	max_attempts integer NOT NULL CHECK (max_attempts > 0),
	available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	lease_owner text,
	lease_token uuid,
	lease_expires_at timestamptz,
	result jsonb,
	error text,
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	completed_at timestamptz,
	CHECK ((status = 'leased') = (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
	UNIQUE(queue_name, idempotency_key)
);

CREATE INDEX IF NOT EXISTS headlesscode_rsi_jobs_claim_idx
	ON headlesscode_rsi_jobs (queue_name, status, available_at, created_at)
	WHERE status IN ('queued', 'leased');
CREATE INDEX IF NOT EXISTS headlesscode_rsi_jobs_lease_idx
	ON headlesscode_rsi_jobs (lease_expires_at)
	WHERE status = 'leased';
