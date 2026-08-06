# Data Model

PostgreSQL is the system of record. Migrations are append-only and checksum-verified by `scripts/migrations/run.ts`; changing an already applied migration causes startup failure and requires a new migration file.

## Canonical ingest

### `chain_event_inbox`

Every stream, backfill or webhook event enters this table before parser side effects.

Important fields:

- identity/order: `idempotency_key`, `signature`, `slot`, `transaction_index`, `instruction_index`, `inner_instruction_index`;
- event time: `occurred_at`, `received_at`, `processed_at`, `finalized_at`;
- provenance: `commitment`, `source`, `decoder_version`, `partition_key`;
- payload audit: insertion-time `payload_sha256` and post-retention `payload_compacted_at`;
- work state: `status`, `attempt_count`, `next_attempt_at`, lock/lease fields and `last_error`.

Statuses are `pending`, `processing`, `retry`, `processed`, `dead_letter` and `rolled_back`. The primary key makes duplicate stream/webhook delivery a no-op. Partial indexes support ordered claims and expired-lease recovery.

### `event_processing_attempts`

Append-style audit of each parser claim: worker, attempt number, start/end, outcome and error. It allows parser success rate and retry history to be inspected without overwriting the inbox payload.

### `pipeline_watermarks`

Per pipeline/partition progress with last contiguous slot/signature, health state and free-form metadata. Claims expose only the oldest unresolved row for each chain/address partition. A retry, active lease or dead-letter head blocks later rows in that partition, so the parser can write the watermark only after contiguous success. The invariant is covered by both memory and PostgreSQL integration tests.

## Time and amount contracts

The persistence contract separates chain time from system processing time:

| Field                       | Meaning                                            |
| --------------------------- | -------------------------------------------------- |
| `occurredAt` / `observedAt` | Transaction `blockTime`; ledger order and pool age |
| `receivedAt`                | First durable local receipt                        |
| `processedAt`               | Parser side effects completed                      |
| `finalizedAt`               | Finalized reconciliation completed                 |

Token amounts use:

```ts
interface TokenAmount {
  rawAmount: string;
  decimals: number;
}
```

`rawAmount` is an unsigned base-10 integer string. Display quantities may be derived later, but must not be used as the accounting source. Existing numeric columns remain for backward compatibility with historical evidence.

The wallet-trade identity includes transaction/instruction position, trader, mint, side and decoder version. This prevents a multi-swap transaction from collapsing distinct legs while retaining deterministic replay.

## Price evidence

### `price_observations`

Stores compact post-entry market paths for deterministic followability and outcome evaluation.
`evidence-sampler` is the sole durable writer and uses a pool-address/120-second bucket identity.
Daily `price_observations` partitions hold the two-day path, while the compact
`price_observation_keys` table enforces idempotency across partitions. Dropping an expired daily
partition releases its heap and indexes to the filesystem.
The live ingestion worker may observe DexScreener more frequently, but keeps that context inline in
the affected wallet evidence and the current `pools` row rather than appending a second history.

### Bounded canonical payload storage

`chain_event_inbox` and `chain_event_payloads` are written atomically before parser side effects.
The inbox keeps the globally unique identity, queue state, ordering metadata, immutable SHA-256 and
an extracted `partition_key`; the complete provider JSON goes to a daily
`chain_event_payloads` partition. A claim joins the payload back transparently, so parser behavior
does not depend on storage layout.

Successfully processed payloads are deleted after 48 hours. Daily partition retirement returns
heap, TOAST and index files to the filesystem instead of leaving reusable-but-allocated pages in
one permanent table. If an old partition still contains pending, retrying or dead-letter work,
maintenance first copies only those unresolved payloads to `chain_event_payload_holds`, then drops
the high-volume partition. Unresolved work is never discarded. Inbox metadata for processed or
rolled-back events remains for three days; verified daily/offsite backups are the recovery source
for older full payloads. Pre-migration inline payloads remain readable through a claim fallback
until they finish or age out.

### `quote_price_observations`

Stores idempotent stablecoin or Pyth quote evidence with fixed publish time, source, confidence, staleness and raw response. Quality values are `oracle-live`, `oracle-historical` and `stablecoin-peg`; the live worker writes this row before accepting the corresponding USD execution conversion.

The schema is present. The live worker currently stores the selected Pyth details inside wallet-trade evidence while calculating USD execution; completing the dedicated quote-observation repository/write path remains a rollout item.

### `wallet_trade_events`

Idempotent normalized buy/sell evidence by wallet/token/pool. New writes can include exact raw base/quote amounts, decoder coordinates and price provenance in the typed/raw payload while keeping compatibility columns such as `base_amount` and `execution_price_usd`.

Price-quality classes:

- `observed-execution`: same-transaction base and stable USD quote amounts;
- `oracle-converted`: same-transaction SOL quote converted with Pyth at transaction time;
- `market-proxy`: market context, not exact execution;
- `historical-estimate`: reconstructed estimate.

Legacy values (`observed-balance`, `price-proxy`, `historical-observed`) remain readable for historical migrations. Only `observed-execution` and `oracle-converted` count toward the v2 candidate high-quality coverage gate.

## FIFO ledger

### `wallet_position_episodes`

One wallet/token round-trip episode per strategy version. It records open/realized/terminal-risk status, cost, proceeds, realized PnL, return, remaining raw inventory, decimals and price-quality coverage.

### `wallet_position_lots`

Buy lots in FIFO order. Each row preserves original and remaining raw amount, cost, fee/slippage allocation, timestamps and state (`open`, `partially_realized`, `realized`, `transferred`).

The research scorer deterministically rebuilds the ledger from wallet trade evidence. Episode/lot materialization is a derived view and must be replay-idempotent: replacing the same strategy snapshot must produce the same row set and score hash.

## Wallet-alpha

- `wallet_entry_signals`: source-linked first wallet entry and risk/flow evidence.
- `wallet_signal_outcomes`: mature/provisional/unresolved followability outcomes measured after bot observation.
- `wallet_alpha_scores`: timestamped status, separate profitability/followability scores, metrics, gates and reasons.
- `wallet_alpha_signals`: one current paper signal per strategy/token.

Scores are versioned by `strategy_version`; reports and APIs should never silently mix versions.
Failed or unknown token risk cannot enter the live wallet-entry/outcome cohort. Transitional
risk-failed/excluded evidence is kept for three days for diagnosis, while admitted wallet evidence
has a 95-day physical horizon that covers the 30/90-day score windows with a five-day buffer.

## Transactional delivery

### `signal_outbox`

When a new `wallet_alpha_signal` is inserted, the same statement creates two rows:

- destination `paper`;
- destination `alert`.

The unique `(signal_id, destination)` constraint prevents duplicate work. Consumers claim eligible/expired rows with `FOR UPDATE SKIP LOCKED`, then mark them `delivered`, `retry` or `dead_letter`. Paper and alert delivery can therefore succeed or retry independently.

`paper_trades` accepts both legacy and wallet-alpha signal IDs; its old direct foreign key was removed because the relationship is polymorphic. Integrity is enforced by the outbox worker and indexed `signal_id`.

### `telegram_notification_outbox`

Dedicated Telegram messages for risk-passed qualified pools and periodic pipeline status use this
table. `(event_type, source_key)` is unique. Claims use a lease and transition through `pending`,
`processing`, `retry`, `delivered` or `dead_letter`; retry state is durable across restarts.

### `telegram_notification_state`

Small durable notifier watermarks live here. The initial activation timestamp prevents historical
pool floods while allowing restarts to rescan the bounded recent eligibility window. It is not a
replacement for canonical pool, risk, signal or pipeline tables.

## Supporting evidence and legacy tables

Migrations `001`-`008` retain token/pool/risk snapshots, price observations, first-entry evidence,
historical market observations/buckets, backfill windows, hypothesis runs, paper trades and
backtests. The live `swaps` table is a transient buy-only bridge into first-entry materialization,
not the wallet ledger: sell accounting and the durable buy/sell history live in
`wallet_trade_events`. Entry-candidate swaps age out after three days; explicit historical backfill
must materialize its entry evidence inside the same controlled workflow. An entry retains
`source_swap_idempotency_key` as an immutable archival reference after the hot bridge row ages out;
its copied flow evidence plus the canonical inbox/backups remain the recovery path.

The old `wallet_positions`, `wallet_scores` and generic `signals` tables belong to the pre-v2 scoring path. New wallet-alpha product reads use `wallet_trade_events`, `wallet_position_*`, `wallet_alpha_scores`, `wallet_alpha_signals` and `signal_outbox`.

## Invariants

- Re-inserting one inbox event cannot create a second canonical row.
- One wallet-alpha signal has at most one paper and one alert outbox row.
- One pool/status source key has at most one Telegram notification outbox row.
- Raw token quantities are never rounded before FIFO allocation.
- Pool age is based on chain time, not receipt/worker time.
- Unknown critical token risk is not equivalent to safe.
- A vault, pool authority, router or program address must not become a wallet-alpha trader.
- Replaying the same normalized trade set in another delivery order must produce the same ledger.
