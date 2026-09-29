DO $$
DECLARE legacy_column record;
DECLARE has_legacy_bytes boolean;
BEGIN
	FOR legacy_column IN
		SELECT column_name FROM information_schema.columns
		WHERE table_schema=current_schema() AND table_name='headlesscode_rsi_artifacts' AND data_type='bytea'
	LOOP
		EXECUTE format('SELECT EXISTS (SELECT 1 FROM headlesscode_rsi_artifacts WHERE %I IS NOT NULL)', legacy_column.column_name) INTO has_legacy_bytes;
		IF has_legacy_bytes THEN
			RAISE EXCEPTION 'RSI artifact column % still contains PostgreSQL blobs; upload legacy bytes to the configured shared object store and migrate their metadata first', legacy_column.column_name;
		END IF;
		EXECUTE format('ALTER TABLE headlesscode_rsi_artifacts DROP COLUMN %I', legacy_column.column_name);
	END LOOP;
END $$;

ALTER TABLE headlesscode_rsi_artifacts ADD COLUMN IF NOT EXISTS storage_id text;
ALTER TABLE headlesscode_rsi_artifacts ADD COLUMN IF NOT EXISTS object_key text;
ALTER TABLE headlesscode_rsi_artifacts ADD COLUMN IF NOT EXISTS backend text;
ALTER TABLE headlesscode_rsi_artifacts ADD COLUMN IF NOT EXISTS byte_length bigint;

DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM headlesscode_rsi_artifacts
		WHERE storage_id IS NULL OR object_key IS NULL OR backend IS NULL OR byte_length IS NULL
	) THEN
		RAISE EXCEPTION 'RSI artifacts need object-store references before migration 002; upload legacy artifact bytes to the configured shared object store and migrate their metadata first';
	END IF;
END $$;

ALTER TABLE headlesscode_rsi_artifacts ALTER COLUMN storage_id SET NOT NULL;
ALTER TABLE headlesscode_rsi_artifacts ALTER COLUMN object_key SET NOT NULL;
ALTER TABLE headlesscode_rsi_artifacts ALTER COLUMN backend SET NOT NULL;
ALTER TABLE headlesscode_rsi_artifacts ALTER COLUMN byte_length SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS headlesscode_rsi_artifacts_object_key_idx ON headlesscode_rsi_artifacts(object_key);

ALTER TABLE headlesscode_rsi_jobs
	ADD COLUMN IF NOT EXISTS lease_duration_ms integer NOT NULL DEFAULT 3600000 CHECK (lease_duration_ms >= 1000);
