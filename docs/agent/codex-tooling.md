# Codex Tooling for Walletscaner

This repository uses the smallest Codex surface that fits each kind of guidance.

| Surface              | Purpose in this repository                                                                |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Root `AGENTS.md`     | Short, always-on project contract and safety invariants                                   |
| `skills.md`          | Detailed domain routes and verification matrices, read on demand                          |
| `.agents/skills/*`   | Discoverable workflows for audit, data pipeline, alpha research and production operations |
| `.codex/hooks.json`  | Mechanical pre-tool safety checks for secrets, B2 deletion and co-tenant mutation         |
| `.codex/config.toml` | Explicit project-instruction byte budget                                                  |
| MCP                  | Add only for authenticated live systems that shell/repository tools cannot safely provide |

## Hooks

The project hook runs before shell and file-edit tools. It denies unambiguous violations:

- reading or editing `.env`, `.env.server` or credential files;
- B2/S3/rclone deletion and bucket/lifecycle commands;
- mutation commands targeting the protected Robinhoodscaner co-tenant.

It adds model-visible warnings, rather than unconditional denials, for operations that can be valid
only after fresh authority and evidence: global Docker prune, volume deletion, Compose `down`,
destructive Git cleanup, recursive deletion, `rsync --delete`, destructive SQL and the legacy
deployment script.

Codex requires review/trust whenever a non-managed hook changes. Use `/hooks` to inspect and trust
the exact definition. Project hooks do not run when the repository is untrusted. Validate the guard
directly with:

```bash
node --test .codex/hooks/pre-tool-use-guard.test.mjs
```

## MCP decision

No project MCP server is enabled by default. This is intentional:

- SSH and repository tools already cover the current server and code workflows.
- A database MCP without a separately provisioned read-only role could expand write and secret
  exposure.
- A GitHub MCP is useful only when issue/PR automation is requested and authenticated with scoped
  permissions.
- A metrics/log MCP becomes useful after a durable Prometheus/Sentry-style source exists.
- Documentation MCPs do not improve the Solana production data path and add startup/context cost.

Add an MCP only when it has a named owner, an exact use case, least-privilege credentials outside
the repository, an allow-listed tool set, bounded timeouts, and `writes` or per-tool approval for
mutations. Never place bearer tokens or credentials directly in `.codex/config.toml`; reference an
environment variable or OAuth instead. A required production MCP must fail startup if unavailable;
an optional research MCP should not.

## Maintenance rule

Do not respond to one incident by appending another permanent global instruction. Put stable safety
and correctness invariants in `AGENTS.md`, reusable work in a skill, mechanical checks in the hook,
and dated runtime facts in `current-state.md` or a report. Delete or consolidate duplicated guidance
when behavior is already enforced by tests or tooling.
