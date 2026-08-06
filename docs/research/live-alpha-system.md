# Live Alpha Research System

This project now includes a cumulative live Solana research loop:

```bash
npm run research:live-alpha
```

The script uses public DEX Screener data for candidate discovery and Solana JSON-RPC for recent pool-account transaction inspection.

## What It Finds

- Fresh or active Solana token candidates from latest profiles and boost feeds.
- Highest-traction pools by liquidity, five-minute volume, buy/sell skew, age, and price change.
- Recent observable wallet balance deltas on pool transactions.
- Early buyers and sellers per candidate.
- Cross-token early buyers when the same wallet appears across multiple high-traction candidates.
- Recent wallet-history enrichment for the strongest early buyers, including unique token buys and pump-token buy counts.

## Outputs

- `reports/live-alpha-latest.json`
- `reports/live-alpha-latest.md`
- `reports/live-alpha-state.json`

The state file is cumulative. Running the script repeatedly creates a stronger wallet watchlist over time.

## Useful Environment Controls

- `SOLANA_RPC_URLS`: comma-separated RPC endpoints. Defaults to official Solana RPC plus PublicNode.
- `LIVE_ALPHA_MAX_CANDIDATES`: number of live token candidates to inspect.
- `LIVE_ALPHA_TX_LIMIT_PER_PAIR`: recent transactions sampled per pair.
- `LIVE_ALPHA_ENRICH_WALLETS`: early-buyer wallets to history-check.
- `LIVE_ALPHA_WALLET_TX_LIMIT`: recent wallet transactions parsed per enriched wallet.

## Limits

Public RPC is not a full indexer. It may miss transactions, return rate limits, or only expose a recent slice of activity. Treat wallet leads as research targets, not copy-trading instructions.
