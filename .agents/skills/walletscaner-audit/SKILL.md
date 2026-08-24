---
name: walletscaner-audit
description: "Diagnose or audit Walletscaner architecture, data quality, runtime health, bottlenecks, storage, and alpha readiness. Use for status, root-cause, review, planning, and read-only production investigations; do not use this skill as authority to mutate production."
---

# Walletscaner Audit

Produce an evidence-backed diagnosis without turning it into an unrequested implementation or
production operation.

1. Read the root `AGENTS.md`, `skills.md` route **Repository investigation**, and
   `docs/agent/current-state.md`. Read only the domain documents needed for the question.
2. State the exact question, scope, observation window, and whether live state is required.
3. Trace source -> durable record -> transformation -> model/outcome -> outbox/consumer. Separate
   process health, delivered-event correctness, source coverage, data maturity, and strategy quality.
4. For live claims, start with bounded read-only checks. Do not print secrets, full environments,
   raw credentials, or unbounded logs/query results.
5. Label each conclusion as verified fact, bounded inference, or open hypothesis. Rank findings by
   correctness/data-loss risk, production safety, co-tenant impact, and resource sustainability.
6. Treat zero backlog, a running container, or 100% decoder success over emitted events as
   insufficient proof of source coverage.
7. End with a go/no-go statement, the smallest credible remediation sequence, measurable exit
   gates, skipped checks, and residual uncertainty.

Do not edit code, data, services, configuration, or external systems unless the user separately
authorizes implementation or a precisely scoped production action.
