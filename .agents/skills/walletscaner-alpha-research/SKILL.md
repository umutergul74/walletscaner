---
name: walletscaner-alpha-research
description: "Evaluate or implement Walletscaner wallet intelligence, token risk, outcome, backtest, signal, and paper-trading research. Use for causal alpha hypotheses and strategy quality; never for real-money execution."
---

# Walletscaner Alpha Research

Treat alpha as a falsifiable, future-only research claim rather than a threshold-tuning exercise.

1. Read the root `AGENTS.md`, `skills.md` routes **Wallet-alpha scoring**, **Evidence price
   sampling**, **Token risk**, and **Research, backtesting, and paper trading** as applicable, plus
   `docs/agent/current-state.md`.
2. Freeze the hypothesis, activation boundary, decision-time features, exact-pool identity, entry
   latency, sizing, fee/slippage model, exit rules, and acceptance gates before examining future
   outcomes.
3. Separate wallet realized profitability, bot-observed followability, token/pool risk, market
   quality, and executable fill evidence. Never substitute same-mint pricing for the exact pool.
4. Exclude coverage gaps, unresolved finality, direct creators, unknown critical risk, missing or
   invalid timing, impossible fills, and post-decision information. Model rug/unsellable states and
   last-sellable evidence explicitly.
5. Use chronological train/validation/untouched holdout windows, negative controls, uncertainty,
   concentration, tail loss, catastrophic-loss rate, and return excluding the best winner. Record
   every attempted cohort, including failures.
6. Keep historical strategy versions immutable. A threshold change creates a new version and a new
   future activation boundary.
7. Promotion requires the repository's mature-market, stable-shadow, paper-duration, coverage,
   fill-realism, and tail-risk gates. Report `waiting` when evidence is immature.

Keep `ENABLE_LIVE_EXECUTION=false`. Do not add signing, private keys, or real-capital execution.
