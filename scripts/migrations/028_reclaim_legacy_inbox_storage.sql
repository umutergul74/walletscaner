-- One-time transition from the legacy inline-JSON inbox to the bounded
-- sidecar layout. This is a table truncation/reload, not VACUUM FULL: only the
-- active queue and the approved three-day metadata horizon are copied.
--
-- Production prerequisite: all Walletscaner writers stopped, a current
-- verified off-host backup, restore-list verification and rollback headroom.
LOCK TABLE chain_event_inbox IN ACCESS EXCLUSIVE MODE;
LOCK TABLE event_processing_attempts IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE chain_event_inbox_keep_028
ON COMMIT DROP
AS
SELECT
  idempotency_key,
  chain,
  signature,
  slot,
  transaction_index,
  instruction_index,
  inner_instruction_index,
  event_type,
  token_address,
  pool_address,
  occurred_at,
  received_at,
  processed_at,
  finalized_at,
  commitment,
  source,
  decoder_version,
  status,
  attempt_count,
  next_attempt_at,
  locked_by,
  locked_at,
  lock_expires_at,
  last_error,
  payload,
  payload_sha256,
  payload_compacted_at,
  COALESCE(NULLIF(partition_key, ''), NULLIF(payload->>'address', ''), source)
    AS partition_key
FROM chain_event_inbox
WHERE status NOT IN ('processed', 'rolled_back')
   OR COALESCE(processed_at, received_at) >= NOW() - INTERVAL '3 days';

CREATE TEMP TABLE event_processing_attempts_keep_028
ON COMMIT DROP
AS
SELECT attempt.*
FROM event_processing_attempts AS attempt
JOIN chain_event_inbox_keep_028 AS kept
  ON kept.idempotency_key = attempt.event_idempotency_key;

TRUNCATE TABLE chain_event_inbox CASCADE;

INSERT INTO chain_event_inbox (
  idempotency_key,
  chain,
  signature,
  slot,
  transaction_index,
  instruction_index,
  inner_instruction_index,
  event_type,
  token_address,
  pool_address,
  occurred_at,
  received_at,
  processed_at,
  finalized_at,
  commitment,
  source,
  decoder_version,
  status,
  attempt_count,
  next_attempt_at,
  locked_by,
  locked_at,
  lock_expires_at,
  last_error,
  payload,
  payload_sha256,
  payload_compacted_at,
  partition_key
)
SELECT *
FROM chain_event_inbox_keep_028;

INSERT INTO event_processing_attempts
SELECT *
FROM event_processing_attempts_keep_028;

SELECT setval(
  pg_get_serial_sequence('event_processing_attempts', 'id'),
  COALESCE((SELECT MAX(id) FROM event_processing_attempts), 1),
  EXISTS(SELECT 1 FROM event_processing_attempts)
);

ANALYZE chain_event_inbox;
ANALYZE event_processing_attempts;
