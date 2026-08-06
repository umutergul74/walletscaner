\set ON_ERROR_STOP on

DO $$
DECLARE
  invalid_indexes INTEGER;
BEGIN
  IF (SELECT relkind FROM pg_class WHERE oid = 'price_observations'::regclass) <> 'p' THEN
    RAISE EXCEPTION 'price_observations is not partitioned';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'chain_event_payloads'::regclass) <> 'p' THEN
    RAISE EXCEPTION 'chain_event_payloads is not partitioned';
  END IF;
  IF EXISTS (
    SELECT 1 FROM chain_event_inbox WHERE idempotency_key = 'storage-old-processed'
  ) THEN
    RAISE EXCEPTION 'expired processed inbox row survived migration 028';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chain_event_inbox
    WHERE idempotency_key = 'storage-recent-processed'
      AND partition_key = 'RecentPool'
  ) THEN
    RAISE EXCEPTION 'recent processed inbox metadata was not preserved';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chain_event_inbox
    WHERE idempotency_key = 'storage-old-retry'
      AND status = 'retry'
      AND payload->>'address' = 'RetryPool'
  ) THEN
    RAISE EXCEPTION 'old unresolved payload was not preserved';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM event_processing_attempts
    WHERE event_idempotency_key = 'storage-old-retry'
      AND status = 'retry'
  ) THEN
    RAISE EXCEPTION 'unresolved attempt audit was not preserved';
  END IF;
  IF EXISTS (
    SELECT 1 FROM price_observations WHERE idempotency_key = 'storage-old-price'
  ) THEN
    RAISE EXCEPTION 'expired price evidence survived bounded-table migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM price_observations WHERE idempotency_key = 'storage-recent-price'
  ) OR NOT EXISTS (
    SELECT 1 FROM price_observation_keys WHERE idempotency_key = 'storage-recent-price'
  ) THEN
    RAISE EXCEPTION 'recent price evidence or its idempotency key was lost';
  END IF;

  SELECT COUNT(*) INTO invalid_indexes
  FROM pg_index
  WHERE NOT indisvalid
    AND indrelid IN (
      'chain_event_inbox'::regclass,
      'price_observations'::regclass,
      'wallet_trade_events'::regclass,
      'wallet_entry_signals'::regclass,
      'wallet_signal_outcomes'::regclass
    );
  IF invalid_indexes > 0 THEN
    RAISE EXCEPTION '% invalid bounded-storage indexes', invalid_indexes;
  END IF;
END
$$;

SELECT
  pg_size_pretty(pg_database_size(current_database())) AS database_size,
  (SELECT COUNT(*) FROM chain_event_inbox) AS inbox_rows,
  (SELECT COUNT(*) FROM price_observations) AS price_rows,
  (SELECT COUNT(*) FROM pg_inherits
   WHERE inhparent = 'chain_event_payloads'::regclass) AS payload_partitions,
  (SELECT COUNT(*) FROM pg_inherits
   WHERE inhparent = 'price_observations'::regclass) AS price_partitions;
