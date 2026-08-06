-- price_observations is high-churn, short-horizon evidence. Rebuild it once
-- as daily partitions so normal retention returns heap and index files to the
-- filesystem. The compact key table preserves idempotency across partitions.
LOCK TABLE price_observations IN ACCESS EXCLUSIVE MODE;

CREATE TABLE price_observation_keys (
  idempotency_key TEXT PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_price_observation_keys_retention
  ON price_observation_keys (observed_at, idempotency_key);

CREATE TABLE price_observations_bounded
  (LIKE price_observations INCLUDING DEFAULTS INCLUDING CONSTRAINTS
    INCLUDING STORAGE INCLUDING COMMENTS)
  PARTITION BY RANGE (observed_at);

DO $$
DECLARE
  day_offset INTEGER;
  lower_bound DATE;
  upper_bound DATE;
  partition_name TEXT;
BEGIN
  FOR day_offset IN -2..8 LOOP
    lower_bound := CURRENT_DATE + day_offset;
    upper_bound := lower_bound + 1;
    partition_name := 'price_observations_' || to_char(lower_bound, 'YYYYMMDD');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF price_observations_bounded
         FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      lower_bound::text || ' 00:00:00+00',
      upper_bound::text || ' 00:00:00+00'
    );
    EXECUTE format(
      'ALTER TABLE %I SET (
         autovacuum_vacuum_scale_factor = 0.03,
         autovacuum_analyze_scale_factor = 0.02,
         autovacuum_vacuum_threshold = 2000,
         autovacuum_analyze_threshold = 1000
       )',
      partition_name
    );
  END LOOP;
END
$$;

CREATE TABLE price_observations_default
  PARTITION OF price_observations_bounded DEFAULT;
ALTER TABLE price_observations_default SET (
  autovacuum_vacuum_scale_factor = 0.03,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 2000,
  autovacuum_analyze_threshold = 1000
);

INSERT INTO price_observation_keys (idempotency_key, observed_at)
SELECT idempotency_key, observed_at
FROM price_observations
WHERE observed_at >= NOW() - INTERVAL '2 days'
ON CONFLICT (idempotency_key) DO NOTHING;

INSERT INTO price_observations_bounded
SELECT *
FROM price_observations
WHERE observed_at >= NOW() - INTERVAL '2 days';

ALTER TABLE price_observations RENAME TO price_observations_unbounded_027;
ALTER TABLE price_observations_bounded RENAME TO price_observations;
DROP TABLE price_observations_unbounded_027;

ALTER TABLE price_observations
  ADD CONSTRAINT price_observations_pkey
  PRIMARY KEY (observed_at, idempotency_key);

CREATE INDEX idx_price_observations_token_time
  ON price_observations (chain, token_address, observed_at);
CREATE INDEX idx_price_observations_sampler
  ON price_observations (token_address, strategy_version, observed_at);
CREATE INDEX idx_price_observations_retention
  ON price_observations (observed_at, idempotency_key);

COMMENT ON TABLE price_observation_keys IS
  'Bounded global idempotency keys for daily-partitioned price evidence.';
