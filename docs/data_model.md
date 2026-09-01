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

### `ingestion_cursors`

Source-level replay position by provider and watched address. Migration 038 adds
`last_event_occurred_at`, the chain time of the last event accepted by canonical storage. Cursor
write time and parser completion time are operational timestamps and must not be substituted for
this value when estimating an uncertain chain interval.

### `ingestion_coverage_incidents`

Append-only evidence that one Solana program's discovery transport may have missed transactions.
The opening identity, provider/program, reason, chain-time gap boundary and observed diagnostics are
immutable. At most one incident may remain open for a provider/program. Restart attempts advance
monotonically; closing freezes the row with the only permitted resolution,
`transport_recovered_gap_unreconciled`. Closing proves fresh transport recovery, not historical
reconstruction.

Migration 044 adds nullable `coverage_reconciled_at` and `coverage_repair_id` proof fields. Migration
046 additionally requires the referenced repair's immutable target to have an exact, separately
persisted `finalized` status proof. The incident fields may
be set only while closing an open incident and only when the referenced repair for that same
incident is complete. Closed incidents without both fields preserve the original unreconciled
meaning and remain excluded by strict consumers.

### `ingestion_gap_repairs` and `ingestion_gap_repair_signatures`

Restart-safe discovery reconciliation state. One collecting/replaying repair may exist per incident.
The repair freezes the old cursor, the first observed target head, the pagination continuation,
attempt counters and completion proof. Signature rows have a unique head-relative position and are
claimed in descending position order, which is oldest-first. Collection, replay and completed states
are explicit; a configured signature-cap breach moves the session to terminal `failed` without
closing coverage. Completed staging rows are operational scratch evidence with bounded retention;
the repair session and incident proof remain durable. `covered_through_*` must equal the immutable
`target_*` pair and completed counts must equal fetched counts. `verified_at`, `target_slot` and
`confirmation_status=finalized` live in the append-only
`ingestion_gap_repair_target_proofs` relation and record the independent exact-target check.
Migration 046 avoids an access-exclusive rewrite of the active repair table. The proof transaction
preserves any pre-fix mutable-cursor completion metadata in `previous_*` fields before normalizing a
fully replayed session to its staged position-zero target.

Strict consumers conservatively exclude a canonical pool when its `created_at` is in the inclusive
interval from `gap_started_at` through `closed_at`, or from `gap_started_at` onward while the incident
is open. Telegram and paper decisions derive program and creation time from the canonical exact pool,
not JSON payload timestamps. Incident open and paper-open use the same per-program transaction
advisory lock. The lock closes the race with a known or concurrently committing incident; a later
incident with a retroactive conservative boundary can still taint an earlier append-only paper fill,
which analysis must exclude. The trigger rejects deletion, opening-evidence rewrites, non-monotonic
restart state and any mutation after close.

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

Daily partition retirement returns heap, TOAST and index files to the filesystem instead of leaving
reusable-but-allocated pages in one permanent table. With migration 033, maintenance may compact or
drop canonical payload data only when a matching daily `archive_segments` row is independently
verified and its observed Object Lock retention has not expired. If an eligible partition still
contains pending, retrying or dead-letter work, maintenance first copies only those unresolved
payloads to `chain_event_payload_holds`, then drops the high-volume partition in the same transaction.
Unresolved work is never discarded. Inbox metadata for processed or rolled-back events retains its
bounded hot horizon. Pre-migration inline payloads remain readable through a claim fallback until
they finish or age out.

### `solana_signature_queue`

Live discovery signatures cross this PostgreSQL boundary before transaction fetching. The natural
key is provider/program/signature. Pending rows retain chain slot, notification time, attempt count,
next due time and the last bounded failure; completed rows keep short-term duplicate evidence.
Migration 057 adds a terminal `dead_letter` state for a transaction that neither primary nor the
metered archival fallback can resolve within the fixed attempt budget. Dead letters are retained,
reported as DOWN and create an `unresolved_transaction` ingestion coverage incident; they are never
silently completed or removed by normal signature-queue retention.

### `archive_segments` and `archive_attempts`

`archive_segments` is one UTC-day manifest per canonical payload source. Its revision, lease,
attempt counts, source/metadata coverage, restored-source hash, compressed-object hash, Content-MD5,
version/ETag and Object Lock receipt make export and retry idempotent. Only `verified` permits source
retirement, and that state requires full canonical metadata coverage plus Governance or Compliance
retention beyond verification time. `object_lock_evidence` distinguishes direct `api-verified`
retention from the weaker, explicitly accepted `attested-default-policy`; consumers must never
present the latter as provider-read proof. A late source insert resets an in-flight segment to a new
revision; an insert into an already verified window is rejected.

`archive_attempts` is the bounded append-only audit of export, upload, verification and restore
claims/results. It is diagnostic evidence, not a replacement for the current manifest row.

### `archive_retirement_policies`

Migration 034 adds one durable policy row for `chain-event-payloads`. Its activation timestamp is
created at deployment. `approve_chain_event_payload_retirement` accepts only a non-empty, fully
verified UTC-day segment wholly after that activation day and records the exact canary revision.
`archive_retirement_policy_ready()` rechecks that evidence and the configured minimum remaining
lock horizon on every maintenance run. A ready policy is necessary but not sufficient: the runtime
`ARCHIVE_RETIREMENT_ENABLED` switch must also be true.
This dual gate prevents historical transport tests or a configuration mistake from authorizing
source removal.

### `quote_price_observations`

Stores idempotent stablecoin or Pyth quote evidence with fixed publish time, source, confidence,
staleness and raw response. Quality values are `oracle-live`, `oracle-historical` and
`stablecoin-peg`; the live worker persists this row before accepting the corresponding USD execution
conversion. Primary-key and natural-key replays are accepted only when immutable price/provenance
fields match; conflicting evidence fails closed and is never overwritten.

### `wallet_trade_events`

Idempotent normalized buy/sell evidence by wallet/token/pool. New writes can include exact raw base/quote amounts, decoder coordinates and price provenance in the typed/raw payload while keeping compatibility columns such as `base_amount` and `execution_price_usd`.

Migration 054 (local validation, not yet production) adds nullable scalar `base_raw_amount` and
`base_token_decimals` without rewriting historical rows. Both are known together or remain NULL;
historical `base_amount` is never silently promoted to exact quantity.

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

The hot FIFO continuation cache stores only non-realized buy lots. Each retained row preserves
original and remaining raw amount, cost, fee/slippage allocation, timestamps and state (`open`,
`partially_realized` or `transferred`). Realized-lot detail is deterministic from the canonical
wallet trades and is retained in the independently restored wallet-evidence archive; its compact
result remains on the scalar episode.

The research scorer deterministically rebuilds the ledger from wallet trade evidence. Episode/lot
materialization is a derived view and must be replay-idempotent: replacing the same strategy
snapshot must produce the same row set and score hash. Wallet-scoped replacement holds the existing
advisory lock and database transaction, removes stale scoped lots/episodes first, and only then
inserts the incoming deterministic projection. This ordering permits an episode id to change while
its natural wallet/token/strategy/index key remains constant without exposing a partial state.

### Transactional FIFO continuation (migration 054; rollout pending)

`wallet_trade_revisions` records one source revision per chain/wallet/strategy plus the oldest dirty
persisted order. `wallet_fifo_continuations` stores an integrity-hashed, at-most-4-MiB checkpoint.
`wallet_fifo_realization_facts` retains one scalar fact per partial sale, separately from completed
round trips. Producer writes and historical/price corrections advance the source revision in their
transaction; checkpoint/fact persistence succeeds only under the expected-revision row lock.

The persisted ordering is `(slot, observed_at, signature COLLATE "C", idempotency_key COLLATE "C")`;
the core uses the same locale-independent code-unit order. First seeding and old-correction rebuilds
use bounded pages; a later append probes/reads only rows after the checkpoint. An old or unknown
dirty boundary requires a full rebuild. The worker preserves closed episode projections and only
replaces current lot state. Entry/outcome-only wakeups verify the same source revision but do not
rewrite an unchanged checkpoint or ledger. These tables are derived continuation evidence, not an
archive receipt and not permission to delete canonical wallet history.

Migration 055 makes source invalidation independent of producer release age. Statement-level
transition-table triggers coalesce canonical inserts, accounting/order updates and deletes to one
revision per affected wallet per SQL statement. Raw/provider-only diagnostic updates are excluded;
they cannot change the FIFO result. This preserves CAS when immutable older producer images and the
new continuation reader overlap during a staged rollout without adding a per-row trigger amplifier.

## Wallet-alpha

Migration 050 adds `wallet-evidence-daily-v1` cold artifacts over complete trade, entry and outcome
rows. `archive_segment_generations` keeps the immutable manifest of every independently verified
revision when late evidence invalidates the current day. These objects are recovery/research
evidence, not executable fills and not permission to retire hot rows before compact-reader parity.

Migration 051 adds normalized `wallet_evidence_*_dimensions`,
`wallet_profitability_episode_facts`, `wallet_open_lot_facts` and
`wallet_followability_facts`. `wallet_evidence_compact_days` binds each shadow result to the exact
verified archive segment/revision and records source counts plus deterministic source/fact parity.
These are shadow tables until reader equivalence and the production observation gate pass. They do
not authorize source deletion, and a corrected archive revision invalidates the old receipt for
selection purposes.

- `wallet_entry_signals`: source-linked first wallet entry and risk/flow evidence.
- `wallet_signal_outcomes`: mature/provisional/unresolved followability outcomes measured after bot observation.
- `wallet_alpha_scores`: timestamped status, separate profitability/followability scores, metrics, gates and reasons.
- `wallet_alpha_score_supersessions`: narrow retention identity for non-latest scores, with the full
  score primary key, replacement time and `ON DELETE CASCADE` back to the score row.
- `wallet_alpha_signals`: one current paper signal per strategy/token.
- `wallet_alpha_work_queue`: one coalescing revision per wallet/strategy with lease/retry state,
  `pending_since`, bounded priority `0..2`, and a durable `unchecked|ready|deferred` expensive-work
  admission checkpoint. Priority and admission are scheduling metadata, never evidence or an alpha
  score. `NOTIFY wallet_alpha_work` is only a commit-bound wake hint; this table is the durable
  source of truth.

The bounded admission prefetch can complete multiple below-threshold queue revisions in one
statement, but only when each row still has the exact measured revision and no active lease. A
concurrent producer revision therefore remains pending. This is queue-state compaction, not evidence
deletion. The FIFO scorer reads a scalar trade projection without `raw` provider JSON; archive and
general evidence readers retain the complete canonical row.

Migration 056 separates canonical collection from expensive scoring admission. For `evidence-v1`,
an unseeded/unqualified wallet is ready only when recent evidence has the upper-bound prerequisites
for the immutable watch gate: at least eight sells plus mature fixed-horizon outcomes for at least
eight distinct source-linked token entries in the 90-day scorer window. This is deliberately a
superset, not an alpha verdict; risk, quality, return and tail gates still run later. A deferred
revision advances only `completed_revision`. All canonical rows and trade-source revisions remain,
and every producer re-evaluates the wallet so the qualifying event promotes it transactionally.
Existing FIFO continuations and the latest watch/candidate/validated-paper score bypass admission
and remain current. Other strategy namespaces retain their explicit legacy behavior.

Scores are versioned by `strategy_version`; reports and APIs should never silently mix versions.
Failed or unknown token risk cannot enter the live wallet-entry/outcome cohort. Transitional
risk-failed/excluded evidence is kept for three days for diagnosis, while admitted wallet evidence
has a 95-day physical horizon that covers the 30/90-day score windows with a five-day buffer.
Only a genuinely inserted changed score records supersession; an identical replay creates neither a
new score nor a queue row. This makes seven-day cleanup proportional to real historical scores
instead of repeatedly scanning old singleton/latest JSON rows.

Queue priority can increase while a revision is pending but cannot create a second copy of the
wallet. Completing revision `N` clears its priority only if the current row is still at revision
`N`; a concurrent revision `N+1` retains its pending timestamp and priority for the next claim.

## Future exact-pool decision tape

Migration 053 additively freezes `survival-execution-tape-v2-20260830` and adds
`alpha_decision_checkpoints.timing_status` (`unmeasured`, `on-time`, `late`). Existing v1 rows are
not relabelled or imported. Atomic completion rejects successful quote evidence outside a v2
checkpoint's due-time + 10-second window; terminal stale evidence can still be retained. The
collector checks the same bounds before/after network calls and never re-quotes an expired entry.

Migration 052 adds four compact research objects without importing or rewriting historical rows:

- `alpha_decision_tape_runs` freezes one strategy version, activation time, feature/quote policy,
  capacity bounds and promotion gates. The first version disables Telegram, paper and live
  execution in its database policy.
- `alpha_decision_tape` stores one decision-time feature snapshot per strategy and exact pool.
  Finality/coverage, critical program risk, creator evidence and identity independence are separate
  states. Unknown evidence remains explicit. `paper_eligible` has a database constraint requiring
  false.
- `alpha_decision_checkpoints` stores the fixed 0/15/30/60/120/300-second work set and bounded
  market/flow result. Pending/retry claims are leased, expired claims recover, and attempt six ends
  in a durable dead letter.
- `alpha_execution_quote_evidence` stores at most one buy or sell row per checkpoint and fixed
  notional. Raw token quantities use `NUMERIC(78,0)`, and a `quoted-not-filled` row is valid only
  when the route resolves to the exact expected pool with all required amounts. Provider payload
  JSON is not stored.

Eligible decisions retain scalar evidence for 60 days. Operational pruning selects the oldest
expired decisions in the normal bounded maintenance budget and deletes them only when every child
checkpoint is `completed` or `dead_letter`; cascades then remove the small child set. A normal
`DELETE` reuses relation space and is a steady-state control, not a promise of immediate filesystem
reclamation.

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
`processing`, `retry`, `delivered`, `dead_letter` or terminal `suppressed`; retry state is durable
across restarts. `suppressed` preserves a queued candidate that later failed canonical provenance or
coverage checks without allowing delivery and without deleting audit evidence.

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
- A coverage-incident opening is immutable and a closed incident cannot be edited or deleted.
- A strict Telegram or paper entry must resolve to the same canonical Solana token/pool and must not
  overlap an unreconciled discovery interval for that pool's program.
- Raw token quantities are never rounded before FIFO allocation.
- Pool age is based on chain time, not receipt/worker time.
- Unknown critical token risk is not equivalent to safe.
- A vault, pool authority, router or program address must not become a wallet-alpha trader.
- Replaying the same normalized trade set in another delivery order must produce the same ledger.
- A future decision cannot become research-eligible with unknown/failed critical risk or coverage,
  and no migration-052 decision can become paper-eligible.
- A `quoted-not-filled` row must have exact-pool identity and complete raw amount evidence; provider
  failure, stale data, no route or wrong pool remains an explicit non-fill state.
