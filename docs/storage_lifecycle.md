# Fixed-disk storage lifecycle

Walletscaner must preserve full research evidence without treating the shared PostgreSQL volume as
an unlimited archive. The durable design is a tiered lifecycle, not periodic emergency deletion.

## Verified production baseline

The raw chain-payload path is bounded and operational. A closed UTC-day partition is streamed as
zstd-3 to B2 Object Lock, independently downloaded and fully restored, and retired only while the
matching manifest, remaining retention, future-only database policy and runtime gate all pass. On
2026-08-16 the first approved retirement removed 12 old source partitions without deleting a
canonical wallet trade, entry, outcome or score.

After the archive rollout, scoped image cleanup and migration 035 rollout on 2026-08-16, the host
had about 11.0 GB available (about 10.3 GiB). The database was about 12.35 GB. The newest verified
server dump and one
off-host-verified rollback generation remain mandatory capacity reservations.

This is not yet a steady-state proof. The admitted wallet-evidence tables cover only about 37-41
calendar days while their configured scoring horizon is 95 days. A healthy process, verified raw
archive and 10 GiB free therefore do not prove that the 95-day hot model fits the fixed disk.

### Production shadow update — 2026-08-26

Migrations 050/051 and immutable R34 are now operational on the shared host. One wallet-evidence
day has passed independent B2 restore verification and its compact-shadow parity; nine historical
days remain in the bounded archive queue and mismatch/dead-letter counts are zero. The guarded
derived-only reclaim returned about 1.51 GB to the filesystem while preserving the canonical
wallet-trade relation and requeueing 16,442 current observed wallets for bounded rebuild. Exact
release-transfer files were then removed without pruning their loaded rollback images. Host free
space is about 18.6 GB.

This is still a shadow, not a retirement cutover. No canonical wallet trade, entry or outcome is
deleted by migrations 050/051 or the materializer, and no wallet-evidence retirement reader/gate is
enabled. The observation must first complete archive catch-up, a clean post-catch-up 24-hour growth
window and seven future days while preserving the 8 GiB reserve. The rollout/reclaim window's
current 24-hour slope is intentionally rejected as equilibrium evidence.

## Measured growth risk

The settled active UTC days 2026-08-14 and 2026-08-15 averaged approximately:

| Evidence | Rows/day | Current total bytes/row | Projected 95-day bytes |
| --- | ---: | ---: | ---: |
| wallet trades | 24,469 | 2,055 | 4.78 GB |
| wallet entries | 6,992 | 7,302 | 4.85 GB |
| signal outcomes | 13,983 | 4,505 | 5.99 GB |

Those three relations alone project to about 15.6 GB at that rate, before FIFO lots/episodes,
scores, the two-day raw-payload window, WAL and backup headroom. The existing 90%/4-GiB ingestion
circuit breaker prevents filesystem exhaustion, but it would pause collection before the 95-day
window matured. It is an emergency boundary, not the long-term capacity solution.

`wallet_alpha_scores` is another boundedness concern: 208,876 latest rows were `insufficient`, and
74,362 of those were already older than 30 days on 2026-08-16. Preserving every latest insufficient
row forever is not a sustainable substitute for a compact wallet state record.

## Immediate controls

- Full raw payloads keep the configured 48-hour hot horizon. Daily partition retirement now uses
  that hour value directly; it no longer inherits the three-day inbox-metadata horizon.
- Archive-gated inbox metadata retirement uses migration 035's partial `received_at` index and
  selects one exact verified archive range at a time. This avoids rescanning pre-archive metadata
  on every pass. The production canary retired 2,000 eligible rows in bounded 500-row batches,
  and the first normal scheduled pass retired another 3,500 while compacting 500 newer rows. Both
  advanced the oldest outstanding cohort and preserved pre-archive and recently processed rows.
- Operations monitoring records at most one small storage sample per hour for 30 days. It reports
  database growth, filesystem consumption and conservative days remaining above an 8-GiB reserve.
  The runway is explicitly immature until at least 24 hours of samples exist, and alerts below 14
  days once mature.
- The 8-GiB reserve is separate from the 90%/4-GiB ingestion stop. It covers recovery dump creation,
  WAL/temporary variation and safe intervention time.
- Docker cleanup remains Walletscaner-image-specific. BuildKit, volumes, the protected co-tenant
  and globally reclaimable Docker bytes are never used as an assumed capacity reserve.

## Target hot/cold model

The next storage phase keeps the exact full evidence in B2 and makes PostgreSQL a bounded online
working set:

1. `wallet-evidence-daily-v1` artifacts contain the complete trade, entry and outcome rows plus
   provenance. They use the same revision, SHA-256, independent-reader restore and Object Lock
   rules as raw payloads, but have a separate source kind and deletion policy.
2. Recent detailed rows remain hot for late enrichment and deterministic handoff. Three days is
   the initial canary horizon; unresolved or unmaterialized rows are never retired.
3. Incremental FIFO processing retains compact open lots and scalar profitability episodes. It no
   longer rebuilds every wallet from 95 days of detailed trades.
4. Mature entry/outcome pairs become a compact followability fact containing the scalar fields used
   by scoring and controlled model research. Verbose JSON and signatures remain in the verified
   evidence artifact.
5. Wallet, token and strategy dimensions replace repeated long text keys in fact indexes. Every
   dimension needs reference-aware retention; no dimension may become an unbounded cemetery.
6. Score history is time-partitioned for seven-day retirement. A separate compact latest-score
   table keeps meaningful active statuses; stale `insufficient` state is reconstructible from the
   canonical queue/evidence and must have a bounded policy.

### Implemented archive foundation (migration 050)

Migration 050 implements the first rollout gate without retiring a source row:

- the shared manifest accepts a separate `wallet-evidence` source with format
  `wallet-evidence-daily-v1`;
- one repeatable-read export contains the complete `wallet_trade_events`, `wallet_entry_signals`
  and `wallet_signal_outcomes` rows for a settled UTC day;
- an independent count for each of the three record types must equal the streamed and restored
  count, in addition to the whole-file source SHA-256 and compressed-object SHA-256;
- the verifier downloads the B2 object, checks Object Lock evidence, decompresses every line and
  validates every envelope before marking the segment verified;
- a correction to an exported day creates a new append-only revision. The manifest of every prior
  verified revision remains in `archive_segment_generations`, so a correction cannot orphan or
  overwrite the old full-fidelity object;
- chain-payload work has claim priority over historical wallet-evidence catch-up. Both sources use
  the same bounded 4% CPU archive container and one-file staging ceiling.

This is **implemented**, not yet operational or retirement authority. Production must apply the
migration, generate and independently restore wallet segments, and pass the compact/dual-read
gates below. Until then, the 95-day detailed source retention stays unchanged.

Derived FIFO storage now persists scalar episodes plus only non-realized lots. A realized lot is
fully represented by the deterministic canonical trade archive and its episode scalar; keeping a
second verbose realized-lot cache caused avoidable WAL and relation growth. The existing derived
cache may be reclaimed only through its verified-backup/stopped-worker operation, after which it
rebuilds in the smaller form.

### Implemented compact shadow (migration 051)

Migration 051 is an additive, non-reader-changing shadow layer. One scheduled materializer claims
at most one independently verified wallet-evidence day per run, rechecks the live source counts
against that exact archive revision, and transactionally maintains normalized wallet/token/strategy
dimensions, scalar profitability episodes, non-realized FIFO continuation lots and mature
followability facts. Source and compact rows must match in count and two deterministic aggregate
digests before `wallet_evidence_compact_days` becomes `verified`; a mismatch is durable and fails
closed. The worker is advisory-lock protected, single-connection, serial, capped at 80 MiB and 5%
of one CPU, and does not delete or redirect a source row.

The operational monitor reports wallet archive backlog/freshness, compact backlog/age and parity
mismatches separately. These receipts prove field-preserving materialization, but do not replace the
reader dual-run or seven-day production shadow gates.

## Populated-clone benchmark

The verified 2026-08-15 production dump was serially restored into an isolated PostgreSQL 16
container. `scripts/test/benchmark-hot-evidence-model.sql` built an unlogged size model without
changing source rows.

| Measurement | Result |
| --- | ---: |
| source trade/entry/outcome/episode/lot relations | 5,502,296,064 bytes |
| compact facts, dimensions, open lots and 3-day trade staging | 406,200,320 bytes |
| measured reduction | 92.62% |
| episode rows source/target | 235,707 / 235,707 |
| non-realized lot rows source/target | 215,769 / 215,769 |
| mature outcome rows source/target | 300,555 / 300,555 |

Deterministic 64-bit aggregate digests over all retained profitability and followability fields
matched exactly between source and target. The benchmark is evidence for the design, not deletion
authority: its tables are unlogged, it excludes B2 artifact cost and it does not yet prove live
dual-write, crash recovery or scorer hash parity.

The later 2026-08-25 PostgreSQL 16 clone exercised the real archive and materializer path over the
complete 2026-08-24 UTC cohort. Exactly 100,078 evidence rows (58,252 trades, 14,206 entries and
27,620 outcomes) produced 174,558,627 canonical bytes and a 16,034,890-byte zstd artifact. An
independent restore reproduced the per-type counts, bytes and source SHA-256. At a 4% CPU ceiling,
export plus restore took 562,489 ms. The 5%-CPU compact pass took 260,459 ms and matched 218,492
episodes, 251,460 non-realized lots and 27,498 mature followability facts. Compact fact relations
for that pass occupied about 188 MiB plus about 3 MiB of dimensions. This is populated-clone proof
for one representative full day, not B2 upload evidence or permission to retire canonical rows.

## Required rollout gates

1. Additive PostgreSQL 16 migration and exact source-kind archive contract; no existing table is
   rewritten or dropped.
2. Populated-clone archive/export/restore test for every historical evidence day, including late
   enrichment invalidation and mature-outcome settlement.
3. Idempotent compact materialization with counts and deterministic field digests equal to source.
4. Dual-read shadow: old and compact scorers produce identical FIFO/score/signal hashes under
   duplicate and reordered delivery.
5. Seven-day production shadow with no positive backlog, bounded dimensions, stable RSS/CPU and a
   storage runway above the configured reserve.
6. Fresh verified PostgreSQL dump, off-host acknowledgement, serial restore proof and measured
   migration/WAL/temp headroom.
7. Only then perform a stopped, reversible reader cutover. Detailed source relations remain intact
   until every B2 object and compact fact cohort passes independent restore and parity checks.
8. Source relation retirement is a separately approved operation. `DELETE`, `VACUUM FULL` or an
   emergency table rewrite is never substituted for this sequence.
