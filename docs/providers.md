# Provider Notes

Implementation inventory updated 2026-07-11. Provider responses are treated as evidence with provenance, not interchangeable truth.

## Jupiter executable-route quote evidence

`JupiterQuoteClient` uses the authenticated Swap V1 quote endpoint in read-only mode. It requests
an `ExactIn`, single-hop route and records expected output, minimum output after slippage tolerance,
price impact, context slot and the AMM account. When an expected signal pool is supplied, a route
through another pool fails closed. Evidence is explicitly labelled `quoted-not-filled`: it is more
realistic than a DexScreener midpoint snapshot, but is not proof that a signed transaction landed.
It may feed only a new future-only shadow/paper cohort after `JUPITER_API_KEY` is configured;
existing negative cohorts remain immutable.

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
no automatic provider failover or dual feed in this adapter.

Quiet standard sockets send a bounded application-level `getHealth` heartbeat every
`SOLANA_DISCOVERY_HEARTBEAT_INTERVAL_SECONDS` (30 seconds by default). A response or provider pong
must arrive within `SOLANA_DISCOVERY_HEARTBEAT_TIMEOUT_MS` (10 seconds); otherwise the socket
generation is fenced and reconnected. Ping, pong and timeout counters are operational transport
evidence and do not by themselves prove historical coverage.

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
`SOLANA_DISCOVERY_GAP_REPAIR_MAX_SIGNATURES` (20,000 by default), so repair cannot become an
unbounded JSON/RPC or PostgreSQL workload. An incident becomes reconciled only after every staged
signature is durably admitted, an independent latest-activity probe matches the repaired head, and
post-incident WebSocket evidence exists. Anything less remains alpha-excluded.

If collection reaches that reviewed cap before the boundary, the repair row becomes `failed` and
is never coverage proof. Once two fresh samples separately prove the current live transport, the
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
