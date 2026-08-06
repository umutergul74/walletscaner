# Risk Policy

Signals are research outputs, not financial advice. The system should prefer false negatives over unsafe alerts.

Automatic high-risk reasons:

- Solana mint or freeze authority retained.
- Extreme top-holder concentration.
- Rapid liquidity removal or very thin liquidity.
- Deployer/creator linked to repeated rugs.
- Wallet cluster dominated by deployer, bundle, sniper, or wash-trading behavior.
- Metadata impersonation or duplicate branding.
- EVM ownership, tax, blacklist, mint, proxy, or honeypot issues when EVM support is added.

Live execution is disabled by default and this repository does not store private keys.

