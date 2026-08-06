# Provider Notes

Implementation inventory updated 2026-07-11. Provider responses are treated as evidence with provenance, not interchangeable truth.

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
