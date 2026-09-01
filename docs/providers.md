# Provider Notes

Implementation inventory updated 2026-07-11. Provider responses are treated as evidence with provenance, not interchangeable truth.

## Jupiter executable-route quote evidence

`JupiterQuoteClient` uses the current authenticated
[Swap V2 `/order`](https://developers.jup.ag/docs/api-reference/swap/order) endpoint without a
`taker`, so the request is quote-only and cannot contain a transaction. It requests `ExactIn` with
fixed slippage and accepts only a single 100% route whose AMM account is the exact expected pool.
It records expected/minimum output, signed price impact, winning router, total/provider fee fields,
platform-fee fields, provider processing time and measured HTTP latency. A response containing a
transaction, a missing/split route or another pool fails closed. Evidence is explicitly labelled
`quoted-not-filled`: it is more realistic than a DexScreener midpoint snapshot, but is not proof
that a transaction would land.

Migration 052's local-only `survival-execution-tape-v1-20260830` collector uses this adapter at
fixed $6/$25/$100 notionals. At decision time it records one buy and an immediate sell quote for
each size; later 15/30/60/120/300-second checkpoints sell the conservative minimum token output
frozen by the corresponding decision-time buy. DexScreener is read by exact pair only. Pair
absence, zero liquidity, stale price, provider failure and a wrong Jupiter pool are durable
non-fill evidence rather than a price estimate. Only normalized scalar evidence is persisted; the
provider response body is never written to PostgreSQL.

The collector is disabled by default and refuses startup without both
`ALPHA_DECISION_TAPE_ENABLED=true` and `JUPITER_API_KEY`. Migration 052 and the collector are not
deployed or operational. They may feed only a future research shadow after a separately authorized
rollout; existing negative cohorts remain immutable, and neither paper nor Telegram consumes the
tape.

The opt-in reviewed venue manifest pins exact current official SDK/IDL commits for Raydium CLMM,
Meteora DBC/DAMM v2/DLMM and Orca Whirlpools. Raydium AMM v4 is deliberately not claimed by this
manifest: it predates Anchor and its official SDK exposes hand-maintained layouts without a safe
low-volume creation-log predicate. Adding its program-wide WebSocket stream would process the
entire high-volume AMM transaction feed and recreate the queue-loss problem. AMM v4 therefore
requires a separate account-state discovery adapter and reviewed fixtures before enablement.

## Helius Enhanced Webhook (free-plan default)

`HELIUS_INGEST_MODE=webhook` uses one existing Enhanced Webhook for `SWAP` events involving the reviewed launch/DEX program IDs. Program-level matching covers pools created after startup without continuously editing the webhook, while the `SWAP` filter avoids paying for unrelated program activity. The API durably inserts normalized events into `chain_event_inbox`; parser work remains asynchronous and duplicate deliveries are idempotent.

- The worker fetches the current webhook and sends `PUT` only when its address/configuration set changed.
- Configuration verification defaults to every 15 minutes to bound webhook-management credits; unchanged program IDs do not trigger an update.
- `HELIUS_WEBHOOK_MANAGEMENT_ENABLED=false` is the free-plan default after deployment verification. The worker then reports external management and makes no recurring management requests; enable it only when automatic webhook ownership is explicitly desired.
- Per-pool automatic RPC gap repair is intentionally disabled in webhook mode. This prevents launch backlog replay from creating hundreds of concurrent free-plan RPC requests.
- `HELIUS_WEBHOOK_ID`, a public HTTPS `HELIUS_WEBHOOK_URL`, and the same non-empty `HELIUS_WEBHOOK_AUTH_HEADER` on Helius and the API are mandatory.
- Helius webhook creation is a one-time external deployment step; the worker updates an existing ID and deliberately does not create a new webhook on every restart.

References:

- https://www.helius.dev/docs/api-reference/webhooks/create-webhook
- https://www.helius.dev/docs/api-reference/webhooks/update-webhook

## Helius full transaction stream (paid-plan option)

`HeliusTransactionEventSource` uses `transactionSubscribe` for the changing set of active pool addresses.

- A notification contains the full transaction, so live swaps do not require a second serialized `getTransaction` request.
- Address filters are chunked; each `accountInclude` subscription is capped at Helius' 50,000-address limit.
- Failed/vote transactions are excluded and token-account balance changes can be requested.
- Dynamic address changes are debounced into one generation refresh, preventing constant pool-launch churn and stale acknowledgements from becoming active state.
- Heartbeats use WebSocket ping/pong when supported, otherwise RPC `getHealth`.
- Reconnect uses exponential backoff, jitter and a configurable maximum delay.
- Reconnect performs bounded, serial address backfill from the parser's processed watermark. An unresolved transaction or block time stops that address's frontier and cannot advance the cursor.
- Full diagnostics expose connection/subscription/reconnect/heartbeat counters.

This source is selected only with `HELIUS_INGEST_MODE=transaction-subscribe`. Program creation discovery remains on the standard source below. If Helius returns `transactionSubscribe is not available on the free plan`, use webhook mode; the adapter records that terminal subscription reason and stops scheduling transaction-stream backfill.

References:

- https://www.helius.dev/docs/api-reference/rpc/websocket/transactionsubscribe
- https://www.helius.dev/docs/faqs/websockets

## Standard Solana RPC/WebSocket

`StandardSolanaEventSource` uses `logsSubscribe` per configured program address and resolves matching signatures over RPC. It is retained for creation/migration discovery and bounded gap repair, where request volume is far below a full swap feed.

The Solana `mentions` filter supports one address per log subscription. The adapter therefore manages address/subscription maps and deduplicates signatures across live and backfill delivery.

Standard-RPC health separates the latency path instead of attributing every old block time to the
provider. `lastWebsocketNotificationAgeMs` measures block time to receipt of a matched live
notification, `lastTransactionQueueDelayMs` measures local queue delay,
`lastTransactionFetchCycleDurationMs` covers the configured visibility delay, request gate, outer
visibility retries and HTTP work, and `lastTransactionHttpDurationMs` measures the latest logical
`getTransaction` call (including the HTTP helper's bounded internal retry budget).
`lastNotificationToObservedMs` closes the live receipt-to-emission interval. Startup/reconnect
backfill is labelled separately and cannot be mistaken for live WebSocket lag. The default
`SOLANA_TRANSACTION_REQUEST_TIMEOUT_MS=10000` and
`SOLANA_TRANSACTION_REQUEST_RETRIES=2` preserve the existing bounded HTTP behavior explicitly.
A live event reaching `SOLANA_PROVIDER_LATENCY_WARNING_MS` (30 seconds by default) marks the source
degraded and increments a durable-for-process counter; the next timely live event may recover
health. Late events are still ingested, so health detection cannot create a coverage gap. There is
no automatic WebSocket failover or dual feed in this adapter.

Discovery transaction resolution has a narrower, bounded archival fallback. A durable signature
gets one primary `getTransaction` cycle; only a null/error result may use
`SOLANA_DISCOVERY_TRANSACTION_FALLBACK_RPC_URL`, or the already configured Helius RPC when the
URLs differ. The fallback is serialized per program at
`SOLANA_DISCOVERY_TRANSACTION_FALLBACK_INTERVAL_MS` (250 ms by default), has one four-second HTTP
attempt and exposes request/recovery/error/timeout counters. It never carries WebSocket discovery,
backfill, gap repair or routine token-risk traffic.

If neither endpoint resolves the transaction, the worker no longer occupies a fetch slot forever.
It increments the PostgreSQL attempt count and sets `next_attempt_at` with exponential delay from
`SOLANA_DISCOVERY_DURABLE_RETRY_BASE_MS` (60 seconds) to
`SOLANA_DISCOVERY_DURABLE_RETRY_MAX_MS` (one hour), then continues other due durable signatures.
After `SOLANA_DISCOVERY_DURABLE_MAX_ATTEMPTS` (six), the row becomes retained `dead_letter`
evidence and opens an `unresolved_transaction` coverage incident. It is not completed, deleted or
counted as covered; operational health is DOWN until repaired. This path is deliberately metered so
the free Helius allowance cannot become an unbounded retry owner.

Quiet standard sockets send a bounded application-level `getHealth` heartbeat every
`SOLANA_DISCOVERY_HEARTBEAT_INTERVAL_SECONDS` (30 seconds by default). A response or provider pong
must arrive within `SOLANA_DISCOVERY_HEARTBEAT_TIMEOUT_MS` (10 seconds); otherwise the socket
generation is fenced and reconnected. Ping, pong and timeout counters are operational transport
evidence and do not by themselves prove historical coverage.

Reconnect scheduling uses bounded exponential backoff with jitter rather than a fixed retry loop.
The default discovery profile starts at one second, caps at five seconds and resets its attempt only
after the socket has remained open for 60 seconds. Diagnostics expose connection state, attempt,
next delay and last-connect time. Automatic startup/reconnect backfills are coalesced per address:
one scan may run and at most one follow-up scan may be requested while it runs. This bounds provider
and database amplification during a rapid close storm without weakening the 500-signature repair
cap or converting a truncated interval into complete coverage.

Exact-pool standard-WebSocket trade observation has a separate optional live queue-age breaker.
`RPC_TRADE_MAX_QUEUE_DELAY_MS` applies only to that trade source; discovery leaves the provider
option unset. A bounded one-timer-per-address watchdog follows the oldest queued live notification;
it does not wait for the admitted ordered head's RPC timeout/retry cycle to finish. At the bound,
source diagnostics record `stale`, pressure time/reason/age and the worker uses its existing
persist-before-unsubscribe coverage release. The already admitted head may finish, but queued work
for only that address is purged and the interval remains explicitly incomplete. Timers are cleared
on unsubscribe/stop. This bounds stale CPU/RPC work without same-address concurrent cursor writes
or unbudgeted Helius HTTP fallback.

Some public RPC providers acknowledge several independent `logsSubscribe` sockets from one host
but silently deliver notifications only on a subset of them. Discovery can therefore split the
configured programs across two standard WebSocket providers with
`SOLANA_DISCOVERY_WS_SECONDARY_URL` and the exact JSON string array in
`SOLANA_DISCOVERY_WS_SECONDARY_PROGRAMS_JSON`. HTTP transaction fetch, cursor and durable repair
semantics remain on `SOLANA_RPC_URL`; only live notification transport is divided. Startup fails
closed if the route is incomplete, duplicated or names an unconfigured program. Health reports
only endpoint hostnames and the primary/secondary route, never credential-bearing URLs. This is a
static, reviewed route rather than automatic failover: a transport change cannot prove or close an
existing coverage gap.

### Ordered admission and discovery coverage

Standard and Helius sources use the same fail-closed delivery contract:

- events for one address are admitted in notification order;
- a cursor is saved only after the canonical handler accepts the event durably;
- a typed temporary admission rejection retries the already fetched event in memory at a bounded
  interval and cannot acknowledge it;
- source stop/reconnect fences obsolete socket generations, including asynchronous message parsing,
  acknowledgement, error, pong and close callbacks;
- backfill performs a bounded one-row boundary probe. Remaining history is reported as per-address
  truncation and cannot advance the cursor across the unknown range;
- the saved cursor carries both slot/signature and the last admitted transaction's chain time.

For high-rate discovery, WebSocket notifications cross `solana_signature_queue` before concurrent
fetch. Restart replay reads only due rows. Completion is allowed only after canonical admission or
an exact postfetch filter; unavailable rows persist attempts and backoff instead. The durable queue
therefore permits bounded fetch concurrency without turning an in-memory crash, provider archive
limit or retry storm into a hidden drop.

`getSignaturesForAddress` pagination cannot prove unbounded history. With no existing cursor, the
first bounded page is an activation sample only; operators must not describe it as reconstructed
pre-activation coverage. With a cursor, an unresolved transaction, missing block time or detected
page-budget truncation fails closed. The per-program supervisor persists that uncertainty as an
ingestion coverage incident rather than manufacturing a healthy denominator.

Discovery reconnect repair uses the separately bounded
`SOLANA_DISCOVERY_INITIAL_BACKFILL_LIMIT=100`,
`SOLANA_DISCOVERY_BACKFILL_PAGE_LIMIT=100` and
`SOLANA_DISCOVERY_MAX_BACKFILL_PAGES=5` profile. The adapter therefore proves at most 500 signatures
before fetching any reconnect transaction; an operator override above the hard 2,000-signature
product ceiling fails startup. This window is deliberately independent from the exact-pool trade
profile. It was selected from the measured LaunchLab reconnect rate and must still emit a durable
`backfill_truncated` incident when the cursor is outside the bounded window.

After such an incident, the standard source uses a separate durable repair session. Signature pages
are staged in `ingestion_gap_repair_signatures` across bounded cycles and process restarts. No
transaction is replayed and no cursor advances until the old durable cursor boundary is reached.
The staged set is then replayed oldest-first in batches of
`SOLANA_DISCOVERY_GAP_REPAIR_REPLAY_LIMIT` (50 by default). Collection fails closed at
`SOLANA_DISCOVERY_GAP_REPAIR_MAX_SIGNATURES` (500 by default on the public filtered route), so
repair cannot become an
unbounded JSON/RPC or PostgreSQL workload. An incident becomes reconciled only after every staged
signature is durably admitted, completion equals the immutable collected target signature/slot, a
separate history-aware signature-status query proves that exact target successful and `finalized`,
and post-incident WebSocket evidence exists. A later live cursor or program head cannot replace or
invalidate that target. Anything less remains alpha-excluded.

If collection reaches that reviewed cap before the boundary, or a persisted collecting/replaying
repair is already above a newly lowered cap, the repair row becomes `failed` and is never coverage
proof. Once two fresh samples separately prove the current live transport, the
incident may close only as `transport_recovered_gap_unreconciled`; the historical interval remains
permanently excluded by strict consumers. This prevents an infeasible high-volume gap from keeping
the current transport degraded forever or driving unbounded RPC, rows and replay work.

The latest-activity probe is a low-frequency diagnostic, not a second ingest feed. It runs only on a
health breach, requests one signature for that exact program and treats HTTP-success JSON-RPC errors
or malformed results as provider failures. A valid empty result is the only quiet answer. A
same-slot/latest-signature mismatch remains ambiguous and therefore triggers recovery rather than a
false healthy conclusion.

Standard RPC cannot filter instruction names server-side. When every address on a source has a
non-empty exact log filter, the adapter first searches the raw notification for the complete
JSON-encoded log string and rejects non-matches before `JSON.parse`. Any unfiltered address disables
this fast path for the whole source, so dynamic trade subscriptions retain their original behavior.
`prefilteredWebsocketMessageCount` and `prefilteredWebsocketMessageBytes` expose the saving. This
reduces parse/allocation/GC work but not inbound network bytes.

After RPC resolves a transaction, discovery reapplies the filter against the Solana program-log
invocation stack. An exact `Program log: Instruction: ...` match is accepted only while the
configured program is the active top frame and that target invocation subsequently completes with
`success`. This admits reviewed inner CPI creation instructions without confusing an identically
named instruction emitted by another program in the same routed transaction. A missing, failed or
malformed target completion fails closed. Once the target frame has completed successfully, a later
unrelated truncated suffix cannot erase that proof. An address with an empty instruction filter
remains intentionally unfiltered for dynamic pool-trade subscriptions.

RPC exact-pool trade observation uses a separate bounded admission lane. Passing the cheap market
gate can start observation before critical token-risk enrichment is known, but it cannot satisfy
alpha admission. The lane has a hard three-pool capacity and deterministic minimum-hold rotation;
only non-alpha-protected observations may be replaced. Capacity rotation, expiry, rug, queue
pressure and irreparable backfill all persist an explicit incomplete-coverage boundary, so a
partial interval cannot be promoted to complete wallet PnL evidence.

The `walletscaner-v3-inner-cpi` discovery decoder walks both top-level instructions and
`meta.innerInstructions`. Raw v0 account indices are resolved from static keys followed by writable
and read-only loaded addresses. A malformed base58 instruction is isolated rather than failing the
whole transaction. The selected pool-create instruction's top-level and optional inner coordinates
are persisted in canonical metadata. Per-process health exposes accepted source events, decoded and
unmatched events, decoded pools and top-level/inner counts both globally and per configured program;
these counters add no provider calls or database rows.

A read-only 24-hour production sample at 2026-08-14 22:00 UTC contained 432 events previously
classified as generic `solana_transaction`. Replaying their still-intact payloads through the local
decoder recovered 328 pool creations, all from inner instructions: 127/134 Pump.fun, 191/234
PumpSwap and 10/64 Raydium CPMM. This proves the coverage defect and the decoder gain, but it is not
deployment evidence; historical reconciliation and the post-release live ratio remain separate
gates.

The deployed discovery socket's 2026-08-14 snapshot had received about 21.6 million messages and
46.1 GB in 13 hours for only 9,680 transaction fetches. That is the measured reason for the raw-text
prefilter; its CPU/RSS benefit still requires a post-release same-profile comparison.

Reference: https://solana.com/docs/rpc/websocket/logssubscribe

## Helius Enhanced Transactions and DAS

- `HeliusEnhancedTransactionBatcher` buffers discovery signatures and flushes chunks of at most 100.
- The historical collector uses Enhanced Transactions under an explicit credit budget.
- Helius DAS metadata supplies token authority/creator context. Holder concentration is verified from Solana RPC supply/largest-account responses rather than accepted from a market-price proxy.
- Wallet API is not called for every observed address. Broad Wallet API enrichment is intentionally absent until an `observed -> watch` gated implementation is justified by live data and credit accounting.

References:

- https://www.helius.dev/docs/api-reference/enhanced-transactions/gettransactions
- https://www.helius.dev/docs/wallet-api/overview

## Venue definitions

Default `.env.example` discovery definitions cover:

- Pump.fun program `6EF8...F6P`: create/create-v2/migrate/migrate-v2;
- PumpSwap program `pAMM...XEA`: create-pool;
- Raydium LaunchLab `LanM...3uj`: initialize variants and migrate-to-CPMM;
- Raydium CPMM `CPMM...KP1C`: initialize variants.

Raydium account layouts and discriminators are pinned in `raydium-manifest.ts` to official IDL commit:

```text
e7e0c96fe77bcf6a020b84a44c47a722aac8e359
```

The manifest includes LaunchLab buy/sell and CPMM swap instruction definitions, top-level/inner-instruction matching, signer verification and infrastructure account extraction. The production worker now passes that match context into the wallet balance decoder and deduplicates transaction-level balance deltas per trader. Fixture-backed integration for every Raydium/Pump trade variant is still an acceptance item; configuration alone is not parse-coverage proof. Orca and Meteora adapters are not implemented in this rollout.

Reference: https://docs.raydium.io/sdk-api/anchor-idl

## Trader and amount rules

A token balance owner is not automatically a trader. The wallet decoder requires one of:

- a message signer/fee payer;
- a user authority verified by the venue instruction decoder.

It rejects the active pool, token/quote mint and supplied infrastructure addresses. Balance differences use integer raw amounts whenever RPC data provides them; `number` values are compatibility/display derivatives.

This prevents ordinary pool vaults from being promoted to wallet-alpha, but acceptance still requires real fixtures for PDAs, routers, Token-2022, ATA creation, inner instructions and multi-swap transactions.

## Pyth

As of 2026-08-26, Hermes and Benchmarks require `PYTH_API_KEY`. The default Hermes URL is
`https://pyth.dourolabs.app/hermes`; existing configured legacy URLs redirect upstream. Missing
credentials make zero HTTP requests. The shared latest/historical circuit uses one bounded attempt,
15-minute auth backoff, 60-second rate-limit backoff and 5–60-second outage backoff. Diagnostics
expose only status/counters, never credentials or provider bodies. Missing USD evidence does not
discard raw canonical trade quantities and must not be replaced with a current market mark.
See the [Pyth upgrade contract](https://docs.pyth.network/price-feeds/core/upgrade/preparing).

The isolated v2 tape requires both Pyth and Jupiter credentials before starting. Quote-only Jupiter
requests are sequential and spaced by 1,050ms for the free-plan budget, with no taker, signing or
submission. Auth/rate-limit failures open a bounded circuit. Quotes arriving after their fixed
10-second horizon window are stale evidence, even if the provider returned a valid price.

`PythPriceClient` provides:

- latest Hermes price with a configured staleness limit;
- historical Benchmarks price from the single-timestamp endpoint, with the configured interval
  retained as the accepted publish-time window. The interval endpoint returns an array of
  per-second updates and must not be parsed as a single price response;
- fixed-point price/confidence parsing;
- feed-ID validation and confidence ratio evidence.

Stablecoin quote legs are direct USD execution observations. SOL quote legs are `oracle-converted` only when same-transaction quote quantity and acceptable Pyth evidence both exist. The worker rejects Pyth evidence whose confidence ratio exceeds its configured quality boundary.

Reference: https://docs.pyth.network/price-feeds/core/use-historical-price-data

## DEX Screener

DEX Screener supplies:

- pool/token market lookup;
- liquidity and recent volume/transaction context;
- source-linked observation and fixed-horizon outcome sampling;
- an approximate mark for paper exits.

It is not used as an exact wallet execution price. `market-proxy` evidence cannot satisfy the candidate high-quality execution coverage gate.

Reference: https://docs.dexscreener.com/api/reference

## Telegram and Discord

Wallet-alpha delivery consumes only `alert` rows from the transactional signal outbox. The dedicated
Telegram notifier also consumes its own leased outbox for risk-passed qualified pools and periodic
status buckets; it never processes the `paper` destination. A message is marked delivered after the
provider accepts it; failures move it to retry/dead-letter. Unique source keys prevent duplicates
under normal lease recovery.

`ALERT_COOLDOWN_MINUTES` suppresses later cross-strategy wallet-alpha contenders for the same token.
Pool notices are independently deduplicated by pool and limited by liquidity, five-minute volume,
token risk, recent age, a 100-row discovery batch, claim batch size and polling interval. Compact,
indexed pool columns are used for this recurring query; the large raw provider payload is not parsed
on every notifier cycle. Telegram has no application-provided
idempotency key, so a crash after remote acceptance but before the local completion write can still
produce a rare duplicate.

References:

- https://core.telegram.org/bots/api#sendmessage
- https://discord.com/developers/docs/resources/webhook#execute-webhook

## Provider failure policy

- Missing critical token-risk data is `unknown`, not safe.
- A missing/poor oracle quote prevents high-quality execution classification.
- A DEX Screener failure must not invent an execution price.
- Provider payloads and selected evidence are retained for replay/debugging.
- Sustained reconnect, rate-limit or stale-price failures must degrade health and block rollout, not silently lower the acceptance bar.
