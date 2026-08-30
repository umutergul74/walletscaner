import type pg from "pg";

export const ALPHA_DECISION_TAPE_VERSION = "survival-execution-tape-v2-20260830";

export interface AlphaDecisionSeedOptions {
  strategyVersion?: string;
  sourceStrategyVersion?: string;
  scanLimit?: number;
  maximumDecisionsPerUtcDay?: number;
}

export interface AlphaDecisionSeedResult {
  inspected: number;
  inserted: number;
  researchEligible: number;
  hasMore: boolean;
  dailyCapacityRemaining: number;
  hourlyCapacityRemaining: number;
}

export interface AlphaDecisionCheckpointClaim {
  checkpointId: number;
  decisionId: string;
  strategyVersion: string;
  tokenAddress: string;
  quoteTokenAddress?: string;
  poolAddress: string;
  dex: string;
  poolCreatedAt: string;
  decidedAt: string;
  initialLiquidityUsd: number;
  horizonSeconds: 0 | 15 | 30 | 60 | 120 | 300;
  dueAt: string;
  deadlineAt?: string;
  attemptCount: number;
  entryRawAmounts: Partial<Record<600 | 2500 | 10000, string>>;
}

export type AlphaExactPairStatus = "live" | "liquidity-zero" | "missing" | "provider-error";

export type AlphaQuoteStatus =
  "quoted-not-filled" | "no-route" | "wrong-pool" | "stale" | "provider-error" | "not-attempted";

export interface AlphaExecutionQuoteEvidence {
  direction: "buy" | "sell";
  notionalUsdCents: 600 | 2500 | 10000;
  positionSource: "new-buy" | "decision-entry";
  status: AlphaQuoteStatus;
  inputMint: string;
  outputMint: string;
  rawInputAmount?: string;
  rawExpectedOutputAmount?: string;
  rawMinimumOutputAmount?: string;
  slippageBps: number;
  priceImpactPercent?: number;
  expectedPoolAddress: string;
  routePoolAddress?: string;
  routeLabel?: string;
  routeRouter?: string;
  providerFeeBps?: number;
  providerFeeMint?: string;
  platformFeeRawAmount?: string;
  platformFeeBps?: number;
  platformFeeMint?: string;
  contextSlot?: number;
  provider: string;
  providerTimeMs?: number;
  httpLatencyMs?: number;
  observedAt: string;
  failureReason?: string;
}

export interface AlphaDecisionCheckpointCompletion {
  exactPairStatus: AlphaExactPairStatus;
  priceUsd?: number;
  liquidityUsd?: number;
  buys5m?: number;
  sells5m?: number;
  uniqueBuyersSinceDecision?: number;
  uniqueSellersSinceDecision?: number;
  clusterAdjustedBuyers?: number;
  identityIndependenceStatus: "passed" | "failed" | "unknown";
  liquidityRemoved?: boolean;
  marketObservedAt?: string;
  marketProvider?: string;
  marketProviderLatencyMs?: number;
  quotes: AlphaExecutionQuoteEvidence[];
}

export interface AlphaDecisionTapeSummary {
  decisions: number;
  researchEligible: number;
  paperEligible: number;
  pendingCheckpoints: number;
  retryCheckpoints: number;
  processingCheckpoints: number;
  completedCheckpoints: number;
  deadLetterCheckpoints: number;
  lateCheckpoints: number;
  oldestDueAgeSeconds?: number;
  quoteRows: number;
  quotedRows: number;
  identityUnknownDecisions: number;
}

export interface AlphaDecisionFlowCounts {
  uniqueBuyers: number;
  uniqueSellers: number;
}

interface Queryable {
  query: pg.Pool["query"];
}

const wrappedSolMint = "So11111111111111111111111111111111111111112";
const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Compact future-only research store. All mutations are one-statement,
 * lease-checked and idempotent; it is intentionally separate from signal and
 * paper outboxes.
 */
export class AlphaDecisionTapeStore {
  constructor(private readonly pool: Queryable) {}

  async seedFutureDecisions(
    options: AlphaDecisionSeedOptions = {}
  ): Promise<AlphaDecisionSeedResult> {
    const strategyVersion = normalized(
      options.strategyVersion ?? ALPHA_DECISION_TAPE_VERSION,
      "strategy version"
    );
    const sourceStrategyVersion = normalized(
      options.sourceStrategyVersion ?? "evidence-v1",
      "source strategy version"
    );
    const scanLimit = boundedInteger(options.scanLimit ?? 1, 1, 25, "scan limit");
    const dailyLimit = boundedInteger(
      options.maximumDecisionsPerUtcDay ?? 100,
      1,
      100,
      "daily decision limit"
    );
    const result = await this.pool.query<{
      inspected: number;
      inserted: number;
      research_eligible: number;
      has_more: boolean;
      daily_capacity_remaining: number;
      hourly_capacity_remaining: number;
    }>(seedSql, [
      strategyVersion,
      sourceStrategyVersion,
      scanLimit,
      dailyLimit,
      wrappedSolMint,
      usdcMint
    ]);
    const row = result.rows[0];
    return {
      inspected: Number(row?.inspected ?? 0),
      inserted: Number(row?.inserted ?? 0),
      researchEligible: Number(row?.research_eligible ?? 0),
      hasMore: row?.has_more === true,
      dailyCapacityRemaining: Number(row?.daily_capacity_remaining ?? 0),
      hourlyCapacityRemaining: Number(row?.hourly_capacity_remaining ?? 0)
    };
  }

  async claimDueCheckpoints(options: {
    workerId: string;
    limit?: number;
    leaseSeconds?: number;
    strategyVersion?: string;
  }): Promise<AlphaDecisionCheckpointClaim[]> {
    const workerId = normalized(options.workerId, "worker ID");
    const strategyVersion = normalized(
      options.strategyVersion ?? ALPHA_DECISION_TAPE_VERSION,
      "strategy version"
    );
    const limit = boundedInteger(options.limit ?? 1, 1, 2, "claim limit");
    const leaseSeconds = boundedInteger(options.leaseSeconds ?? 45, 15, 120, "lease seconds");
    const result = await this.pool.query(claimSql, [
      strategyVersion,
      workerId,
      limit,
      leaseSeconds
    ]);
    return result.rows.map(mapCheckpointClaim);
  }

  async completeCheckpoint(
    checkpoint: Pick<
      AlphaDecisionCheckpointClaim,
      "checkpointId" | "horizonSeconds" | "poolAddress"
    >,
    workerId: string,
    completion: AlphaDecisionCheckpointCompletion
  ): Promise<boolean> {
    validateCompletion(completion);
    const normalizedWorkerId = normalized(workerId, "worker ID");
    const quoteKeys = new Set<string>();
    for (const quote of completion.quotes) {
      validateQuote(quote);
      if (quote.expectedPoolAddress !== checkpoint.poolAddress) {
        throw new Error("Checkpoint quote must target the decision's exact pool.");
      }
      const key = `${quote.direction}:${quote.notionalUsdCents}`;
      if (quoteKeys.has(key)) throw new Error(`Duplicate checkpoint quote: ${key}.`);
      quoteKeys.add(key);
    }
    validateQuoteSurface(checkpoint.horizonSeconds, completion.quotes, quoteKeys);

    const result = await this.pool.query<{ completed: boolean }>(completeSql, [
      checkpoint.checkpointId,
      normalizedWorkerId,
      completion.exactPairStatus,
      completion.priceUsd ?? null,
      completion.liquidityUsd ?? null,
      completion.buys5m ?? null,
      completion.sells5m ?? null,
      completion.uniqueBuyersSinceDecision ?? null,
      completion.uniqueSellersSinceDecision ?? null,
      completion.clusterAdjustedBuyers ?? null,
      completion.identityIndependenceStatus,
      completion.liquidityRemoved ?? null,
      completion.marketObservedAt ?? null,
      completion.marketProvider ?? null,
      completion.marketProviderLatencyMs ?? null,
      JSON.stringify(completion.quotes.map(quoteRecord))
    ]);
    return result.rows[0]?.completed === true;
  }

  async failCheckpoint(
    checkpoint: Pick<AlphaDecisionCheckpointClaim, "checkpointId">,
    workerId: string,
    error: string,
    options: { retrySeconds?: number; maximumAttempts?: number } = {}
  ): Promise<"retry" | "dead_letter" | "lost-lease"> {
    const normalizedWorkerId = normalized(workerId, "worker ID");
    const retrySeconds = boundedInteger(options.retrySeconds ?? 30, 5, 900, "retry seconds");
    const maximumAttempts = boundedInteger(options.maximumAttempts ?? 6, 1, 6, "maximum attempts");
    const safeError = normalized(error, "checkpoint error").slice(0, 1024);
    const result = await this.pool.query<{ status: "retry" | "dead_letter" }>(
      `UPDATE alpha_decision_checkpoints
       SET status = CASE WHEN attempt_count >= $5 THEN 'dead_letter' ELSE 'retry' END,
           available_at = CASE
             WHEN attempt_count >= $5 THEN available_at
             ELSE NOW() + make_interval(secs => $4::integer)
           END,
           locked_by = NULL,
           locked_at = NULL,
           lock_expires_at = NULL,
           completed_at = CASE WHEN attempt_count >= $5 THEN NOW() ELSE NULL END,
           last_error = $3,
           updated_at = NOW()
       WHERE id = $1
         AND status = 'processing'
         AND locked_by = $2
         AND lock_expires_at > NOW()
       RETURNING status`,
      [checkpoint.checkpointId, normalizedWorkerId, safeError, retrySeconds, maximumAttempts]
    );
    return result.rows[0]?.status ?? "lost-lease";
  }

  async getSummary(
    strategyVersion = ALPHA_DECISION_TAPE_VERSION
  ): Promise<AlphaDecisionTapeSummary> {
    const result = await this.pool.query<{
      decisions: number;
      research_eligible: number;
      paper_eligible: number;
      pending_checkpoints: number;
      retry_checkpoints: number;
      processing_checkpoints: number;
      completed_checkpoints: number;
      dead_letter_checkpoints: number;
      late_checkpoints: number;
      oldest_due_age_seconds: number | null;
      quote_rows: number;
      quoted_rows: number;
      identity_unknown_decisions: number;
    }>(summarySql, [normalized(strategyVersion, "strategy version")]);
    const row = result.rows[0];
    return {
      decisions: Number(row?.decisions ?? 0),
      researchEligible: Number(row?.research_eligible ?? 0),
      paperEligible: Number(row?.paper_eligible ?? 0),
      pendingCheckpoints: Number(row?.pending_checkpoints ?? 0),
      retryCheckpoints: Number(row?.retry_checkpoints ?? 0),
      processingCheckpoints: Number(row?.processing_checkpoints ?? 0),
      completedCheckpoints: Number(row?.completed_checkpoints ?? 0),
      deadLetterCheckpoints: Number(row?.dead_letter_checkpoints ?? 0),
      lateCheckpoints: Number(row?.late_checkpoints ?? 0),
      ...(row?.oldest_due_age_seconds === null || row?.oldest_due_age_seconds === undefined
        ? {}
        : { oldestDueAgeSeconds: Number(row.oldest_due_age_seconds) }),
      quoteRows: Number(row?.quote_rows ?? 0),
      quotedRows: Number(row?.quoted_rows ?? 0),
      identityUnknownDecisions: Number(row?.identity_unknown_decisions ?? 0)
    };
  }

  async measureFlow(decisionId: string, observedAt: string): Promise<AlphaDecisionFlowCounts> {
    const normalizedDecisionId = normalized(decisionId, "decision ID");
    if (!Number.isFinite(Date.parse(observedAt))) {
      throw new Error("Flow observation time is invalid.");
    }
    const result = await this.pool.query<{ unique_buyers: number; unique_sellers: number }>(
      `SELECT
         COUNT(DISTINCT trade.wallet_address) FILTER (WHERE trade.side = 'buy')::integer
           AS unique_buyers,
         COUNT(DISTINCT trade.wallet_address) FILTER (WHERE trade.side = 'sell')::integer
           AS unique_sellers
       FROM alpha_decision_tape decision
       LEFT JOIN wallet_trade_events trade
         ON trade.chain = decision.chain
        AND trade.token_address = decision.token_address
        AND trade.pool_address = decision.pool_address
        AND trade.observed_at >= decision.decided_at
        AND trade.observed_at <= $2::timestamptz
       WHERE decision.id = $1
         AND $2::timestamptz >= decision.decided_at
         AND $2::timestamptz <= decision.decided_at + INTERVAL '10 minutes'`,
      [normalizedDecisionId, observedAt]
    );
    return {
      uniqueBuyers: Number(result.rows[0]?.unique_buyers ?? 0),
      uniqueSellers: Number(result.rows[0]?.unique_sellers ?? 0)
    };
  }
}

const seedSql = String.raw`
WITH run AS MATERIALIZED (
  SELECT strategy_version, activated_at, policy
  FROM alpha_decision_tape_runs
  WHERE strategy_version = $1
    AND status = 'shadow'
), capacity AS MATERIALIZED (
  SELECT GREATEST(
    0,
    $4::integer - COUNT(decision.id)::integer
  ) AS remaining,
  GREATEST(0, COALESCE(MAX((run.policy->>'maximumDecisionsPerUtcHour')::integer), $4::integer)
    - COUNT(decision.id) FILTER (WHERE decision.decided_at >= date_trunc('hour', NOW()))::integer
  ) AS hourly_remaining,
  COALESCE(MAX((run.policy->>'maximumSeedBatch')::integer), 25) AS seed_limit
  FROM run
  LEFT JOIN alpha_decision_tape decision
    ON decision.strategy_version = run.strategy_version
   AND decision.decided_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
), candidate_pools AS MATERIALIZED (
  SELECT pool.*
  FROM run JOIN pools pool
    ON pool.chain = 'solana' AND pool.created_at >= run.activated_at
   AND pool.created_at <= NOW() - INTERVAL '120 seconds'
   AND pool.created_at >= NOW() - INTERVAL '30 minutes'
  WHERE (SELECT LEAST(remaining, hourly_remaining) FROM capacity) > 0
    AND NOT EXISTS (
      SELECT 1 FROM alpha_decision_tape existing
      WHERE existing.strategy_version = run.strategy_version
        AND existing.chain = pool.chain AND existing.pool_address = pool.pool_address
    )
  ORDER BY pool.created_at, pool.pool_address
  LIMIT $3::integer + 1
), source_candidates AS MATERIALIZED (
  SELECT pool.*, token.creator_address, token.metadata,
         risk.risk_score, risk.confidence, risk.warnings, risk.calculated_at,
         flow.unique_buyers_5m, flow.unique_sellers_5m, flow.creator_buys_before_decision,
         finality.slot AS source_slot,
         EXISTS (
           SELECT 1
           FROM ingestion_coverage_incidents incident
           WHERE incident.chain = pool.chain
             AND incident.coverage_reconciled_at IS NULL
             AND incident.program_address = pool.dex
             AND incident.gap_started_at <= NOW()
             AND COALESCE(incident.closed_at, 'infinity'::timestamptz) >= pool.created_at
         ) AS coverage_incident_open
  FROM run
  CROSS JOIN candidate_pools pool
  LEFT JOIN tokens token
    ON token.chain = pool.chain AND token.address = pool.base_token_address
  LEFT JOIN LATERAL (
    SELECT assessment.risk_score, assessment.confidence,
           assessment.warnings, assessment.calculated_at
    FROM token_risk_assessments assessment
    WHERE assessment.chain = pool.chain
      AND assessment.token_address = pool.base_token_address
      AND assessment.calculated_at <= NOW()
    ORDER BY assessment.calculated_at DESC
    LIMIT 1
  ) risk ON true
  LEFT JOIN LATERAL (
    SELECT event.slot
    FROM chain_event_inbox event
    WHERE event.chain = pool.chain
      AND event.event_type = 'pool_created'
      AND event.occurred_at BETWEEN pool.created_at - INTERVAL '1 minute'
                                AND pool.created_at + INTERVAL '5 minutes'
      AND event.pool_address = pool.pool_address
      AND event.status = 'processed'
      AND event.finalized_at IS NOT NULL
    ORDER BY event.slot DESC NULLS LAST, event.received_at DESC
    LIMIT 1
  ) finality ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(DISTINCT trade.wallet_address) FILTER (
             WHERE trade.side = 'buy'
               AND trade.observed_at >= GREATEST(pool.created_at, NOW() - INTERVAL '5 minutes')
           )::integer
             AS unique_buyers_5m,
           COUNT(DISTINCT trade.wallet_address) FILTER (
             WHERE trade.side = 'sell'
               AND trade.observed_at >= GREATEST(pool.created_at, NOW() - INTERVAL '5 minutes')
           )::integer
             AS unique_sellers_5m,
           COUNT(*) FILTER (
             WHERE trade.side = 'buy'
               AND token.creator_address IS NOT NULL
               AND trade.wallet_address = token.creator_address
           )::integer AS creator_buys_before_decision
    FROM wallet_trade_events trade
    WHERE trade.chain = pool.chain
      AND trade.token_address = pool.base_token_address
      AND trade.pool_address = pool.pool_address
      AND trade.observed_at >= pool.created_at
      AND trade.observed_at <= NOW()
  ) flow ON true
  WHERE NOT EXISTS (
    SELECT 1 FROM alpha_decision_tape existing
    WHERE existing.strategy_version = run.strategy_version
      AND existing.chain = pool.chain
      AND existing.pool_address = pool.pool_address
  )
    AND (SELECT LEAST(remaining, hourly_remaining) FROM capacity) > 0
  ORDER BY pool.created_at, pool.pool_address
  LIMIT $3::integer + 1
), bounded AS MATERIALIZED (
  SELECT candidate.*
  FROM source_candidates candidate
  CROSS JOIN capacity
  ORDER BY candidate.created_at, candidate.pool_address
  LIMIT LEAST($3::integer, (SELECT LEAST(remaining, hourly_remaining, seed_limit) FROM capacity))
), classified AS MATERIALIZED (
  SELECT bounded.*,
         CASE WHEN jsonb_typeof(bounded.raw->'buys5m') = 'number'
           THEN (bounded.raw->>'buys5m')::integer ELSE 0 END AS buys_5m,
         CASE WHEN jsonb_typeof(bounded.raw->'sells5m') = 'number'
           THEN (bounded.raw->>'sells5m')::integer ELSE 0 END AS sells_5m,
         CASE WHEN jsonb_typeof(bounded.raw#>'{tradeCoverage,complete}') = 'boolean'
           THEN (bounded.raw#>>'{tradeCoverage,complete}')::boolean ELSE FALSE END
           AS trade_coverage_complete,
         CASE
           WHEN bounded.coverage_incident_open THEN 'failed'
           WHEN bounded.source_slot IS NULL THEN 'unknown'
           WHEN NOT CASE WHEN jsonb_typeof(bounded.raw#>'{tradeCoverage,complete}') = 'boolean'
             THEN (bounded.raw#>>'{tradeCoverage,complete}')::boolean ELSE FALSE END
             THEN 'failed'
           ELSE 'passed'
         END AS coverage_status,
         CASE
           WHEN bounded.coverage_incident_open THEN 'open-discovery-coverage-incident'
           WHEN bounded.source_slot IS NULL THEN 'finalized-pool-source-not-proven'
           WHEN NOT CASE WHEN jsonb_typeof(bounded.raw#>'{tradeCoverage,complete}') = 'boolean'
             THEN (bounded.raw#>>'{tradeCoverage,complete}')::boolean ELSE FALSE END
             THEN 'exact-pool-trade-coverage-incomplete'
           ELSE 'canonical-finalized-and-gap-free'
         END AS coverage_reason,
         CASE
           WHEN bounded.calculated_at IS NULL THEN 'unknown'
           WHEN bounded.risk_score = 0
             AND bounded.confidence >= 90
             AND jsonb_typeof(bounded.warnings) = 'array'
             AND jsonb_array_length(bounded.warnings) = 0
             AND bounded.metadata->>'tokenRiskPassed' = 'true'
             AND bounded.metadata->>'mintAuthorityRevoked' = 'true'
             AND bounded.metadata->>'freezeAuthorityRevoked' = 'true'
             AND jsonb_typeof(bounded.metadata->'top10HolderPercent') = 'number'
             AND (bounded.metadata->>'top10HolderPercent')::numeric <= 70
             AND bounded.metadata->>'tokenProgram' IN ('spl-token', 'token-2022')
             AND bounded.metadata->>'tokenExtensionEvidenceKnown' = 'true'
             AND jsonb_typeof(bounded.metadata->'blockingTokenExtensions') = 'array'
             AND jsonb_array_length(bounded.metadata->'blockingTokenExtensions') = 0
             THEN 'passed'
           ELSE 'failed'
         END AS risk_status,
         CASE
           WHEN bounded.creator_address IS NULL THEN 'unknown'
           WHEN COALESCE(bounded.creator_buys_before_decision, 0) > 0 THEN 'failed'
           ELSE 'passed'
         END AS creator_status,
         CASE
           WHEN jsonb_typeof(bounded.metadata->'blockingTokenExtensions') = 'array'
             THEN jsonb_array_length(bounded.metadata->'blockingTokenExtensions')
           ELSE NULL
         END AS blocking_extension_count
  FROM bounded
), inserted AS (
  INSERT INTO alpha_decision_tape (
    id, strategy_version, chain, token_address, quote_token_address, pool_address, dex,
    pool_created_at, decided_at, retain_until, source_strategy_version, source_slot,
    price_usd, liquidity_usd, volume_5m_usd, buys_5m, sells_5m,
    unique_buyers_5m, unique_sellers_5m, creator_buys_before_decision,
    trade_coverage_complete, coverage_status, coverage_reason,
    risk_status, risk_score, risk_confidence, risk_assessed_at,
    mint_authority_revoked, freeze_authority_revoked, top_10_holder_percent,
    token_program, token_extension_evidence_known, blocking_token_extension_count,
    creator_address, creator_status, identity_independence_status,
    research_eligible, paper_eligible, missing_evidence
  )
  SELECT
    encode(digest($1 || ':solana:' || classified.pool_address, 'sha256'), 'hex'),
    $1, classified.chain, classified.base_token_address, classified.quote_token_address,
    classified.pool_address, classified.dex, classified.created_at, NOW(),
    NOW() + INTERVAL '60 days', $2, classified.source_slot,
    classified.price_usd, COALESCE(classified.liquidity_usd, 0),
    COALESCE(classified.volume_5m_usd, 0), classified.buys_5m, classified.sells_5m,
    COALESCE(classified.unique_buyers_5m, 0), COALESCE(classified.unique_sellers_5m, 0),
    CASE WHEN classified.creator_address IS NULL THEN NULL
         ELSE COALESCE(classified.creator_buys_before_decision, 0) END,
    classified.trade_coverage_complete, classified.coverage_status,
    classified.coverage_reason, classified.risk_status, classified.risk_score,
    classified.confidence, classified.calculated_at,
    CASE WHEN classified.metadata->>'mintAuthorityRevoked' IN ('true', 'false')
      THEN (classified.metadata->>'mintAuthorityRevoked')::boolean ELSE NULL END,
    CASE WHEN classified.metadata->>'freezeAuthorityRevoked' IN ('true', 'false')
      THEN (classified.metadata->>'freezeAuthorityRevoked')::boolean ELSE NULL END,
    CASE WHEN jsonb_typeof(classified.metadata->'top10HolderPercent') = 'number'
      THEN (classified.metadata->>'top10HolderPercent')::numeric ELSE NULL END,
    CASE WHEN classified.metadata->>'tokenProgram' IN ('spl-token', 'token-2022', 'unknown')
      THEN classified.metadata->>'tokenProgram' ELSE NULL END,
    CASE WHEN classified.metadata->>'tokenExtensionEvidenceKnown' IN ('true', 'false')
      THEN (classified.metadata->>'tokenExtensionEvidenceKnown')::boolean ELSE NULL END,
    classified.blocking_extension_count, classified.creator_address,
    classified.creator_status, 'unknown',
    classified.coverage_status = 'passed'
      AND classified.risk_status = 'passed'
      AND classified.creator_status <> 'failed'
      AND classified.quote_token_address IN ($5, $6)
      AND COALESCE(classified.liquidity_usd, 0) >= 5000
      AND COALESCE(classified.volume_5m_usd, 0) >= 1000
      AND classified.buys_5m + classified.sells_5m >= 5,
    FALSE,
    array_remove(ARRAY[
      CASE WHEN classified.coverage_status <> 'passed' THEN classified.coverage_reason END,
      CASE WHEN classified.risk_status <> 'passed' THEN 'critical-token-risk-not-passed' END,
      CASE WHEN classified.creator_status = 'unknown' THEN 'creator-identity-unknown' END,
      CASE WHEN classified.creator_status = 'failed' THEN 'direct-creator-buy-observed' END,
      'funder-cluster-bundle-independence-unknown',
      'priority-and-landing-fee-evidence-unknown',
      CASE WHEN classified.quote_token_address IS NULL THEN 'quote-mint-unknown'
           WHEN classified.quote_token_address NOT IN ($5, $6) THEN 'quote-mint-unsupported' END
    ]::text[], NULL)
  FROM classified
  ON CONFLICT (strategy_version, chain, pool_address) DO NOTHING
  RETURNING id, decided_at, research_eligible
), checkpoints AS (
  INSERT INTO alpha_decision_checkpoints (
    decision_id, horizon_seconds, due_at, available_at
  )
  SELECT inserted.id, horizon.horizon_seconds,
         inserted.decided_at + make_interval(secs => horizon.horizon_seconds),
         inserted.decided_at + make_interval(secs => horizon.horizon_seconds)
  FROM inserted
  CROSS JOIN (VALUES (0), (15), (30), (60), (120), (300)) horizon(horizon_seconds)
  WHERE inserted.research_eligible
  ON CONFLICT (decision_id, horizon_seconds) DO NOTHING
  RETURNING 1
)
SELECT
  LEAST((SELECT COUNT(*) FROM source_candidates), $3::integer)::integer AS inspected,
  (SELECT COUNT(*) FROM inserted)::integer AS inserted,
  (SELECT COUNT(*) FROM inserted WHERE research_eligible)::integer AS research_eligible,
  ((SELECT COUNT(*) FROM source_candidates) > $3::integer
    OR (SELECT LEAST(remaining, hourly_remaining) FROM capacity) = 0) AS has_more,
  GREATEST(0, (SELECT remaining FROM capacity) - (SELECT COUNT(*) FROM inserted))::integer
    AS daily_capacity_remaining,
  GREATEST(0, (SELECT hourly_remaining FROM capacity) - (SELECT COUNT(*) FROM inserted))::integer
    AS hourly_capacity_remaining`;

const claimSql = String.raw`
WITH expired_candidates AS MATERIALIZED (
  SELECT checkpoint.id
  FROM alpha_decision_checkpoints checkpoint
  JOIN alpha_decision_tape decision ON decision.id = checkpoint.decision_id
  WHERE decision.strategy_version = $1 AND checkpoint.status = 'processing'
    AND checkpoint.lock_expires_at <= NOW()
  ORDER BY checkpoint.lock_expires_at, checkpoint.id
  LIMIT 25
  FOR UPDATE OF checkpoint SKIP LOCKED
), expired AS (
  UPDATE alpha_decision_checkpoints checkpoint
  SET status = CASE WHEN checkpoint.attempt_count >= 6 THEN 'dead_letter' ELSE 'retry' END,
      locked_by = NULL, locked_at = NULL, lock_expires_at = NULL,
      available_at = NOW(),
      completed_at = CASE WHEN checkpoint.attempt_count >= 6 THEN NOW() ELSE NULL END,
      last_error = 'checkpoint lease expired', updated_at = NOW()
  FROM expired_candidates
  WHERE checkpoint.id = expired_candidates.id
  RETURNING checkpoint.id
), candidates AS MATERIALIZED (
  SELECT checkpoint.id
  FROM alpha_decision_checkpoints checkpoint
  JOIN alpha_decision_tape decision ON decision.id = checkpoint.decision_id
  WHERE decision.strategy_version = $1
    AND decision.research_eligible
    AND checkpoint.status IN ('pending', 'retry')
    AND checkpoint.available_at <= NOW()
    AND checkpoint.due_at <= NOW()
    AND (checkpoint.horizon_seconds = 0 OR EXISTS (
      SELECT 1 FROM alpha_decision_checkpoints initial
      WHERE initial.decision_id = checkpoint.decision_id AND initial.horizon_seconds = 0
        AND initial.status IN ('completed', 'dead_letter')
    ))
  ORDER BY checkpoint.due_at, checkpoint.id
  LIMIT $3
  FOR UPDATE OF checkpoint SKIP LOCKED
), claimed AS (
  UPDATE alpha_decision_checkpoints checkpoint
  SET status = 'processing', attempt_count = checkpoint.attempt_count + 1,
      locked_by = $2, locked_at = NOW(),
      lock_expires_at = NOW() + make_interval(secs => $4::integer),
      last_error = NULL, updated_at = NOW()
  FROM candidates
  WHERE checkpoint.id = candidates.id
    AND checkpoint.attempt_count < 6
  RETURNING checkpoint.*
)
SELECT claimed.id AS checkpoint_id, claimed.decision_id,
       decision.strategy_version, decision.token_address, decision.quote_token_address,
       decision.pool_address, decision.dex, decision.pool_created_at, decision.decided_at,
       decision.liquidity_usd AS initial_liquidity_usd,
       claimed.horizon_seconds, claimed.due_at, claimed.attempt_count,
       claimed.due_at + (run.policy->>'maximumCheckpointLatenessMs')::integer
         * INTERVAL '1 millisecond' AS deadline_at,
       COALESCE(entry.entry_raw_amounts, '{}'::jsonb) AS entry_raw_amounts
FROM claimed
JOIN alpha_decision_tape decision ON decision.id = claimed.decision_id
JOIN alpha_decision_tape_runs run ON run.strategy_version = decision.strategy_version
LEFT JOIN LATERAL (
  SELECT jsonb_object_agg(quote.notional_usd_cents::text, quote.raw_minimum_output_amount::text)
           AS entry_raw_amounts
  FROM alpha_decision_checkpoints initial
  JOIN alpha_execution_quote_evidence quote ON quote.checkpoint_id = initial.id
  WHERE initial.decision_id = claimed.decision_id
    AND initial.horizon_seconds = 0
    AND quote.direction = 'buy'
    AND quote.status = 'quoted-not-filled'
) entry ON true
ORDER BY claimed.due_at, claimed.id`;

const completeSql = String.raw`
WITH lease AS MATERIALIZED (
  SELECT checkpoint.id, checkpoint.decision_id, checkpoint.horizon_seconds, checkpoint.due_at,
         decision.pool_address, decision.token_address, decision.quote_token_address,
         checkpoint.due_at + (run.policy->>'maximumCheckpointLatenessMs')::integer
           * INTERVAL '1 millisecond' AS deadline_at
  FROM alpha_decision_checkpoints checkpoint
  JOIN alpha_decision_tape decision ON decision.id = checkpoint.decision_id
  JOIN alpha_decision_tape_runs run ON run.strategy_version = decision.strategy_version
  WHERE checkpoint.id = $1
    AND checkpoint.status = 'processing'
    AND checkpoint.locked_by = $2
    AND checkpoint.lock_expires_at > NOW()
    AND NOT EXISTS (
      SELECT 1 FROM alpha_execution_quote_evidence quote
      WHERE quote.checkpoint_id = checkpoint.id
    )
  FOR UPDATE
), quote_input AS MATERIALIZED (
  SELECT *
  FROM jsonb_to_recordset($16::jsonb) AS quote(
    direction text, notional_usd_cents integer, position_source text, status text,
    input_mint text, output_mint text, raw_input_amount numeric,
    raw_expected_output_amount numeric, raw_minimum_output_amount numeric,
    slippage_bps integer, price_impact_percent numeric, expected_pool_address text,
    route_pool_address text, route_label text, route_router text,
    provider_fee_bps integer, provider_fee_mint text, platform_fee_raw_amount numeric,
    platform_fee_bps integer, platform_fee_mint text,
    context_slot bigint, provider text, provider_time_ms integer,
    http_latency_ms integer, observed_at timestamptz, failure_reason text
  )
), valid_lease AS MATERIALIZED (
  SELECT lease.*
  FROM lease
  WHERE (lease.deadline_at IS NULL OR NOT EXISTS (
    SELECT 1 FROM quote_input quote WHERE quote.status = 'quoted-not-filled'
      AND (quote.observed_at < lease.due_at OR quote.observed_at > lease.deadline_at)
  )) AND NOT EXISTS (
    SELECT 1 FROM quote_input quote
    WHERE quote.status = 'quoted-not-filled' AND (
      quote.input_mint <> CASE WHEN quote.direction = 'buy' THEN lease.quote_token_address ELSE lease.token_address END
      OR quote.output_mint <> CASE WHEN quote.direction = 'buy' THEN lease.token_address ELSE lease.quote_token_address END
      OR (quote.direction = 'sell' AND NOT EXISTS (
        SELECT 1 FROM quote_input buy
        WHERE lease.horizon_seconds = 0 AND buy.direction = 'buy' AND buy.status = 'quoted-not-filled'
          AND buy.notional_usd_cents = quote.notional_usd_cents
          AND buy.raw_minimum_output_amount = quote.raw_input_amount
        UNION ALL
        SELECT 1 FROM alpha_decision_checkpoints initial
        JOIN alpha_execution_quote_evidence buy ON buy.checkpoint_id = initial.id
        WHERE lease.horizon_seconds > 0 AND initial.decision_id = lease.decision_id
          AND initial.horizon_seconds = 0 AND initial.status = 'completed'
          AND buy.direction = 'buy' AND buy.status = 'quoted-not-filled'
          AND buy.notional_usd_cents = quote.notional_usd_cents
          AND buy.raw_minimum_output_amount = quote.raw_input_amount
      ))
    )
  ) AND (
    (
        lease.horizon_seconds = 0
        AND (SELECT COUNT(*) FROM quote_input) = 6
        AND (SELECT COUNT(*) FROM quote_input WHERE direction = 'buy') = 3
        AND (SELECT COUNT(*) FROM quote_input WHERE direction = 'sell') = 3
        AND (SELECT BOOL_AND(position_source = 'new-buy') FROM quote_input) IS TRUE
      ) OR (
        lease.horizon_seconds > 0
        AND (SELECT COUNT(*) FROM quote_input) = 3
        AND (SELECT COUNT(*) FROM quote_input WHERE direction = 'sell') = 3
        AND (SELECT BOOL_AND(position_source = 'decision-entry') FROM quote_input) IS TRUE
      )
    )
  AND (SELECT COUNT(DISTINCT (direction, notional_usd_cents)) FROM quote_input) =
      (SELECT COUNT(*) FROM quote_input)
  AND (SELECT COUNT(DISTINCT notional_usd_cents) FROM quote_input) = 3
  AND (SELECT BOOL_AND(expected_pool_address = lease.pool_address) FROM quote_input) IS TRUE
), inserted_quotes AS (
  INSERT INTO alpha_execution_quote_evidence (
    checkpoint_id, direction, notional_usd_cents, position_source, status,
    input_mint, output_mint, raw_input_amount, raw_expected_output_amount,
    raw_minimum_output_amount, slippage_bps, price_impact_percent,
    expected_pool_address, route_pool_address, route_label, route_router,
    provider_fee_bps, provider_fee_mint, platform_fee_raw_amount,
    platform_fee_bps, platform_fee_mint, context_slot, provider, provider_time_ms, http_latency_ms,
    observed_at, failure_reason
  )
  SELECT valid_lease.id, quote.*
  FROM valid_lease CROSS JOIN quote_input quote
  RETURNING checkpoint_id
), completed AS (
  UPDATE alpha_decision_checkpoints checkpoint
  SET status = 'completed', exact_pair_status = $3, price_usd = $4,
      liquidity_usd = $5, buys_5m = $6, sells_5m = $7,
      unique_buyers_since_decision = $8, unique_sellers_since_decision = $9,
      cluster_adjusted_buyers = $10, identity_independence_status = $11,
      liquidity_removed = $12, market_observed_at = $13, market_provider = $14,
      market_provider_latency_ms = $15, completed_at = NOW(),
      timing_status = CASE WHEN valid_lease.deadline_at IS NULL THEN 'unmeasured'
        WHEN $13::timestamptz BETWEEN valid_lease.due_at AND valid_lease.deadline_at
          AND (SELECT BOOL_AND(observed_at BETWEEN valid_lease.due_at AND valid_lease.deadline_at)
               FROM quote_input) IS TRUE THEN 'on-time' ELSE 'late' END,
      locked_by = NULL, locked_at = NULL, lock_expires_at = NULL,
      last_error = NULL, updated_at = NOW()
  FROM valid_lease
  WHERE checkpoint.id = valid_lease.id
    AND (SELECT COUNT(*) FROM inserted_quotes) = (SELECT COUNT(*) FROM quote_input)
  RETURNING checkpoint.id
)
SELECT EXISTS (SELECT 1 FROM completed) AS completed`;

const summarySql = String.raw`
WITH decisions AS MATERIALIZED (
  SELECT id, research_eligible, paper_eligible, identity_independence_status
  FROM alpha_decision_tape WHERE strategy_version = $1
), checkpoints AS MATERIALIZED (
  SELECT checkpoint.id, checkpoint.status, checkpoint.due_at, checkpoint.timing_status
  FROM alpha_decision_checkpoints checkpoint
  JOIN decisions decision ON decision.id = checkpoint.decision_id
)
SELECT
  (SELECT COUNT(*) FROM decisions)::integer AS decisions,
  (SELECT COUNT(*) FROM decisions WHERE research_eligible)::integer AS research_eligible,
  (SELECT COUNT(*) FROM decisions WHERE paper_eligible)::integer AS paper_eligible,
  (SELECT COUNT(*) FROM checkpoints WHERE status = 'pending')::integer AS pending_checkpoints,
  (SELECT COUNT(*) FROM checkpoints WHERE status = 'retry')::integer AS retry_checkpoints,
  (SELECT COUNT(*) FROM checkpoints WHERE status = 'processing')::integer AS processing_checkpoints,
  (SELECT COUNT(*) FROM checkpoints WHERE status = 'completed')::integer AS completed_checkpoints,
  (SELECT COUNT(*) FROM checkpoints WHERE status = 'dead_letter')::integer AS dead_letter_checkpoints,
  (SELECT COUNT(*) FROM checkpoints WHERE timing_status = 'late')::integer AS late_checkpoints,
  (SELECT EXTRACT(EPOCH FROM NOW() - MIN(due_at))
   FROM checkpoints WHERE status IN ('pending', 'retry') AND due_at <= NOW())
    AS oldest_due_age_seconds,
  (SELECT COUNT(*) FROM alpha_execution_quote_evidence quote
   JOIN checkpoints checkpoint ON checkpoint.id = quote.checkpoint_id)::integer AS quote_rows,
  (SELECT COUNT(*) FROM alpha_execution_quote_evidence quote
   JOIN checkpoints checkpoint ON checkpoint.id = quote.checkpoint_id
   WHERE quote.status = 'quoted-not-filled')::integer AS quoted_rows,
  (SELECT COUNT(*) FROM decisions WHERE identity_independence_status = 'unknown')::integer
    AS identity_unknown_decisions`;

function mapCheckpointClaim(row: Record<string, unknown>): AlphaDecisionCheckpointClaim {
  const amounts = (row.entry_raw_amounts ?? {}) as Record<string, unknown>;
  const entryRawAmounts: AlphaDecisionCheckpointClaim["entryRawAmounts"] = {};
  for (const size of [600, 2500, 10000] as const) {
    const amount = amounts[String(size)];
    if (typeof amount === "string") entryRawAmounts[size] = amount;
  }
  return {
    checkpointId: Number(row.checkpoint_id),
    decisionId: String(row.decision_id),
    strategyVersion: String(row.strategy_version),
    tokenAddress: String(row.token_address),
    ...(row.quote_token_address ? { quoteTokenAddress: String(row.quote_token_address) } : {}),
    poolAddress: String(row.pool_address),
    dex: String(row.dex),
    poolCreatedAt: new Date(String(row.pool_created_at)).toISOString(),
    decidedAt: new Date(String(row.decided_at)).toISOString(),
    initialLiquidityUsd: Number(row.initial_liquidity_usd),
    horizonSeconds: Number(row.horizon_seconds) as AlphaDecisionCheckpointClaim["horizonSeconds"],
    dueAt: new Date(String(row.due_at)).toISOString(),
    ...(row.deadline_at ? { deadlineAt: new Date(String(row.deadline_at)).toISOString() } : {}),
    attemptCount: Number(row.attempt_count),
    entryRawAmounts
  };
}

function quoteRecord(quote: AlphaExecutionQuoteEvidence): Record<string, unknown> {
  return {
    direction: quote.direction,
    notional_usd_cents: quote.notionalUsdCents,
    position_source: quote.positionSource,
    status: quote.status,
    input_mint: quote.inputMint,
    output_mint: quote.outputMint,
    raw_input_amount: quote.rawInputAmount ?? null,
    raw_expected_output_amount: quote.rawExpectedOutputAmount ?? null,
    raw_minimum_output_amount: quote.rawMinimumOutputAmount ?? null,
    slippage_bps: quote.slippageBps,
    price_impact_percent: quote.priceImpactPercent ?? null,
    expected_pool_address: quote.expectedPoolAddress,
    route_pool_address: quote.routePoolAddress ?? null,
    route_label: quote.routeLabel ?? null,
    route_router: quote.routeRouter ?? null,
    provider_fee_bps: quote.providerFeeBps ?? null,
    provider_fee_mint: quote.providerFeeMint ?? null,
    platform_fee_raw_amount: quote.platformFeeRawAmount ?? null,
    platform_fee_bps: quote.platformFeeBps ?? null,
    platform_fee_mint: quote.platformFeeMint ?? null,
    context_slot: quote.contextSlot ?? null,
    provider: quote.provider,
    provider_time_ms: quote.providerTimeMs ?? null,
    http_latency_ms: quote.httpLatencyMs ?? null,
    observed_at: quote.observedAt,
    failure_reason: quote.failureReason ?? null
  };
}

function validateCompletion(completion: AlphaDecisionCheckpointCompletion): void {
  if (completion.exactPairStatus === "live") {
    nonnegative(completion.priceUsd, "live exact-pair price");
    nonnegative(completion.liquidityUsd, "live exact-pair liquidity");
    if ((completion.priceUsd ?? 0) <= 0 || (completion.liquidityUsd ?? 0) <= 0) {
      throw new Error("A live exact pair requires positive price and liquidity.");
    }
  }
  for (const [name, value] of [
    ["buys5m", completion.buys5m],
    ["sells5m", completion.sells5m],
    ["uniqueBuyersSinceDecision", completion.uniqueBuyersSinceDecision],
    ["uniqueSellersSinceDecision", completion.uniqueSellersSinceDecision],
    ["clusterAdjustedBuyers", completion.clusterAdjustedBuyers],
    ["marketProviderLatencyMs", completion.marketProviderLatencyMs]
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative integer.`);
    }
  }
}

function validateQuote(quote: AlphaExecutionQuoteEvidence): void {
  normalized(quote.inputMint, "quote input mint");
  normalized(quote.outputMint, "quote output mint");
  normalized(quote.expectedPoolAddress, "expected quote pool");
  normalized(quote.provider, "quote provider");
  if (![600, 2500, 10000].includes(quote.notionalUsdCents)) {
    throw new Error("Quote notional is outside the frozen $6/$25/$100 surface.");
  }
  boundedInteger(quote.slippageBps, 0, 10_000, "quote slippage");
  if (
    quote.priceImpactPercent !== undefined &&
    (!Number.isFinite(quote.priceImpactPercent) ||
      quote.priceImpactPercent < -100 ||
      quote.priceImpactPercent > 100)
  ) {
    throw new Error("Quote price impact must be between -100 and 100 percentage points.");
  }
  if (quote.providerFeeBps !== undefined) {
    boundedInteger(quote.providerFeeBps, 0, 10_000, "provider fee bps");
  }
  if (quote.platformFeeBps !== undefined) {
    boundedInteger(quote.platformFeeBps, 0, 10_000, "platform fee bps");
  }
  if (
    quote.platformFeeRawAmount !== undefined &&
    (!/^\d+$/u.test(quote.platformFeeRawAmount) || BigInt(quote.platformFeeRawAmount) < 0n)
  ) {
    throw new Error("Platform fee amount must be a non-negative raw integer.");
  }
  if (quote.routeRouter !== undefined) normalized(quote.routeRouter, "quote router");
  if (quote.providerFeeMint !== undefined) normalized(quote.providerFeeMint, "provider fee mint");
  if (quote.platformFeeMint !== undefined) normalized(quote.platformFeeMint, "platform fee mint");
  if (!Number.isFinite(Date.parse(quote.observedAt))) {
    throw new Error("Quote observation time is invalid.");
  }
  if (quote.status === "quoted-not-filled") {
    for (const [name, value] of [
      ["raw input", quote.rawInputAmount],
      ["raw expected output", quote.rawExpectedOutputAmount],
      ["raw minimum output", quote.rawMinimumOutputAmount]
    ]) {
      if (!value || !/^\d+$/u.test(value) || BigInt(value) <= 0n) {
        throw new Error(`Quoted ${name} amount must be a positive raw integer.`);
      }
    }
    if (quote.routePoolAddress !== quote.expectedPoolAddress || quote.failureReason) {
      throw new Error("Quoted evidence must use the exact expected pool without a failure reason.");
    }
  } else if (!quote.failureReason?.trim()) {
    throw new Error("Non-quoted evidence requires a failure reason.");
  }
}

function validateQuoteSurface(
  horizonSeconds: AlphaDecisionCheckpointClaim["horizonSeconds"],
  quotes: AlphaExecutionQuoteEvidence[],
  keys: Set<string>
): void {
  const directions = horizonSeconds === 0 ? (["buy", "sell"] as const) : (["sell"] as const);
  const expectedPositionSource = horizonSeconds === 0 ? "new-buy" : "decision-entry";
  const expectedCount = directions.length * 3;
  if (quotes.length !== expectedCount) {
    throw new Error(
      `Checkpoint horizon ${horizonSeconds} requires exactly ${expectedCount} quote evidence rows.`
    );
  }
  for (const direction of directions) {
    for (const notional of [600, 2500, 10000] as const) {
      if (!keys.has(`${direction}:${notional}`)) {
        throw new Error(`Checkpoint quote surface is missing ${direction}:${notional}.`);
      }
    }
  }
  if (quotes.some((quote) => quote.positionSource !== expectedPositionSource)) {
    throw new Error(
      `Checkpoint horizon ${horizonSeconds} requires ${expectedPositionSource} quote evidence.`
    );
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function nonnegative(value: number | undefined, name: string): void {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
}

function normalized(value: string, name: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${name} is required.`);
  return result;
}
