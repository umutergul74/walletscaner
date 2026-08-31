-- Producer-independent FIFO source invalidation.
--
-- Migration 054 introduced the revision/CAS contract. Several deliberately immutable production
-- producer images predate the repository calls that invoke it, so the database must enforce that
-- contract at the canonical table boundary. Statement-level transition tables coalesce a batch to
-- one revision change per affected wallet and avoid an unbounded row-trigger write amplifier.

CREATE OR REPLACE FUNCTION record_wallet_trade_insert_statement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected RECORD;
BEGIN
  FOR affected IN
    SELECT DISTINCT ON (
      chain COLLATE "C", wallet_address COLLATE "C", strategy_version COLLATE "C"
    )
      chain, wallet_address, strategy_version, slot, observed_at, signature, idempotency_key
    FROM wallet_fifo_new_rows
    ORDER BY
      chain COLLATE "C",
      wallet_address COLLATE "C",
      strategy_version COLLATE "C",
      slot,
      observed_at,
      signature COLLATE "C",
      idempotency_key COLLATE "C"
  LOOP
    PERFORM record_wallet_trade_revision(
      affected.chain,
      affected.wallet_address,
      affected.strategy_version,
      affected.slot,
      affected.observed_at,
      affected.signature,
      affected.idempotency_key
    );
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION record_wallet_trade_update_statement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected RECORD;
BEGIN
  FOR affected IN
    WITH changed AS (
      SELECT
        old_row.idempotency_key AS old_key,
        old_row.chain AS old_chain,
        old_row.wallet_address AS old_wallet_address,
        old_row.strategy_version AS old_strategy_version,
        old_row.slot AS old_slot,
        old_row.observed_at AS old_observed_at,
        old_row.signature AS old_signature,
        new_row.idempotency_key AS new_key,
        new_row.chain AS new_chain,
        new_row.wallet_address AS new_wallet_address,
        new_row.strategy_version AS new_strategy_version,
        new_row.slot AS new_slot,
        new_row.observed_at AS new_observed_at,
        new_row.signature AS new_signature
      FROM wallet_fifo_old_rows AS old_row
      FULL OUTER JOIN wallet_fifo_new_rows AS new_row
        ON new_row.idempotency_key = old_row.idempotency_key
      WHERE old_row.idempotency_key IS NULL
         OR new_row.idempotency_key IS NULL
         OR (to_jsonb(new_row) - 'raw' - 'provider')
              IS DISTINCT FROM
            (to_jsonb(old_row) - 'raw' - 'provider')
    ), boundaries AS (
      SELECT
        old_chain AS chain,
        old_wallet_address AS wallet_address,
        old_strategy_version AS strategy_version,
        old_slot AS slot,
        old_observed_at AS observed_at,
        old_signature AS signature,
        old_key AS idempotency_key
      FROM changed
      WHERE old_key IS NOT NULL
      UNION ALL
      SELECT
        new_chain,
        new_wallet_address,
        new_strategy_version,
        new_slot,
        new_observed_at,
        new_signature,
        new_key
      FROM changed
      WHERE new_key IS NOT NULL
    )
    SELECT DISTINCT ON (
      chain COLLATE "C", wallet_address COLLATE "C", strategy_version COLLATE "C"
    )
      chain, wallet_address, strategy_version, slot, observed_at, signature, idempotency_key
    FROM boundaries
    ORDER BY
      chain COLLATE "C",
      wallet_address COLLATE "C",
      strategy_version COLLATE "C",
      slot,
      observed_at,
      signature COLLATE "C",
      idempotency_key COLLATE "C"
  LOOP
    PERFORM record_wallet_trade_revision(
      affected.chain,
      affected.wallet_address,
      affected.strategy_version,
      affected.slot,
      affected.observed_at,
      affected.signature,
      affected.idempotency_key
    );
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION record_wallet_trade_delete_statement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected RECORD;
BEGIN
  FOR affected IN
    SELECT DISTINCT ON (
      chain COLLATE "C", wallet_address COLLATE "C", strategy_version COLLATE "C"
    )
      chain, wallet_address, strategy_version, slot, observed_at, signature, idempotency_key
    FROM wallet_fifo_old_rows
    ORDER BY
      chain COLLATE "C",
      wallet_address COLLATE "C",
      strategy_version COLLATE "C",
      slot,
      observed_at,
      signature COLLATE "C",
      idempotency_key COLLATE "C"
  LOOP
    PERFORM record_wallet_trade_revision(
      affected.chain,
      affected.wallet_address,
      affected.strategy_version,
      affected.slot,
      affected.observed_at,
      affected.signature,
      affected.idempotency_key
    );
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS wallet_trade_revision_after_insert ON wallet_trade_events;
CREATE TRIGGER wallet_trade_revision_after_insert
AFTER INSERT ON wallet_trade_events
REFERENCING NEW TABLE AS wallet_fifo_new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION record_wallet_trade_insert_statement();

DROP TRIGGER IF EXISTS wallet_trade_revision_after_update ON wallet_trade_events;
CREATE TRIGGER wallet_trade_revision_after_update
AFTER UPDATE ON wallet_trade_events
REFERENCING OLD TABLE AS wallet_fifo_old_rows NEW TABLE AS wallet_fifo_new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION record_wallet_trade_update_statement();

DROP TRIGGER IF EXISTS wallet_trade_revision_after_delete ON wallet_trade_events;
CREATE TRIGGER wallet_trade_revision_after_delete
AFTER DELETE ON wallet_trade_events
REFERENCING OLD TABLE AS wallet_fifo_old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION record_wallet_trade_delete_statement();

COMMENT ON FUNCTION record_wallet_trade_insert_statement() IS
  'Coalesces canonical inserts to one FIFO source revision per wallet per statement.';
COMMENT ON FUNCTION record_wallet_trade_update_statement() IS
  'Coalesces accounting/order updates while ignoring raw/provider-only diagnostics.';
COMMENT ON FUNCTION record_wallet_trade_delete_statement() IS
  'Invalidates FIFO state when canonical wallet trade evidence is removed.';
