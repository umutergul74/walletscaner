import { createHash } from "node:crypto";
import type pg from "pg";
import {
  CAUSAL_WALLET_SHADOW_QUALIFICATION_VERSION,
  strictQualifiedPoolNotificationPolicy
} from "@memecoin-alpha/shared";
import type {
  IngestionCoverageIncidentStatus,
  IngestionCoverageIncidentTransition,
  PaperTradeNotification,
  PipelineStatusNotification,
  QualifiedPoolNotification
} from "@memecoin-alpha/shared";

export type TelegramNotificationEventType = "qualified-pool" | "status" | "paper-trade";

export interface TelegramNotificationMessage {
  id: string;
  eventType: TelegramNotificationEventType;
  sourceKey: string;
  payload: QualifiedPoolNotification | PipelineStatusNotification | PaperTradeNotification;
  attemptCount: number;
}

export interface QualifiedPoolScanOptions {
  startedAt: string;
  maxAgeMinutes: number;
  minimumLiquidityUsd: number;
  minimumVolume5mUsd: number;
  excludedTokenAddresses: string[];
  deliveryMode?: "notify" | "shadow";
}

export interface QualifiedPoolScanResult {
  scannedPoolCount: number;
  riskPassedPoolCount: number;
  strictCandidateCount: number;
  inserted: number;
}

interface Queryable {
  query: pg.Pool["query"];
}

export class TelegramNotificationStore {
  constructor(private readonly pool: Queryable) {}

  async initializeStartedAt(initialLookbackMinutes: number): Promise<string> {
    const proposedStartedAt = new Date(
      Date.now() - Math.max(0, initialLookbackMinutes) * 60_000
    ).toISOString();
    const result = await this.pool.query<{ started_at: string }>(
      `WITH initialized AS (
         INSERT INTO telegram_notification_state (state_key, state_value)
         VALUES ('notifier-started-at', jsonb_build_object('startedAt', $1::text))
         ON CONFLICT (state_key) DO NOTHING
         RETURNING state_value
       )
       SELECT state_value->>'startedAt' AS started_at FROM initialized
       UNION ALL
       SELECT state_value->>'startedAt' AS started_at
       FROM telegram_notification_state
       WHERE state_key = 'notifier-started-at'
         AND NOT EXISTS (SELECT 1 FROM initialized)
       LIMIT 1`,
      [proposedStartedAt]
    );
    const startedAt = result.rows[0]?.started_at;
    if (!startedAt) throw new Error("Telegram notifier start watermark could not be initialized.");
    return new Date(startedAt).toISOString();
  }

  async enqueueQualifiedPools(options: QualifiedPoolScanOptions): Promise<QualifiedPoolScanResult> {
    const policy = strictQualifiedPoolNotificationPolicy;
    const deliveryMode = options.deliveryMode ?? "notify";
    const qualificationVersion =
      deliveryMode === "shadow" ? CAUSAL_WALLET_SHADOW_QUALIFICATION_VERSION : policy.version;
    const result = await this.pool.query<{
      scanned_pool_count: number;
      risk_passed_pool_count: number;
      strict_candidate_count: number;
      inserted: number;
    }>(
      `WITH recent_pools AS MATERIALIZED (
         SELECT
           pool.chain,
           pool.pool_address,
           pool.base_token_address,
           COALESCE(
             NULLIF(pool.token_symbol, ''),
             NULLIF(token.symbol, ''),
             LEFT(pool.base_token_address, 4) || '...' || RIGHT(pool.base_token_address, 4)
           ) AS token_symbol,
           COALESCE(
             NULLIF(pool.token_name, ''),
             NULLIF(token.name, ''),
             'Unknown token'
           ) AS token_name,
           pool.dex,
           pool.created_at,
           pool.liquidity_usd,
           COALESCE(pool.volume_5m_usd, 0) AS volume_5m_usd,
           pool.price_usd,
           pool.market_cap_usd,
           risk.risk_score,
           risk.confidence,
           risk.warnings,
           risk.calculated_at AS risk_assessed_at,
           CASE
             WHEN jsonb_typeof(risk.sub_scores->'holderDistribution') = 'number'
               THEN 100 - (risk.sub_scores->>'holderDistribution')::numeric
             ELSE NULL
           END AS top10_holder_percent,
           CASE
             WHEN jsonb_typeof(pool.raw->'buys5m') = 'number'
               THEN (pool.raw->>'buys5m')::integer
             ELSE NULL
           END AS buys_5m,
           CASE
             WHEN jsonb_typeof(pool.raw->'sells5m') = 'number'
               THEN (pool.raw->>'sells5m')::integer
             ELSE NULL
           END AS sells_5m,
           COALESCE((pool.raw#>>'{tradeCoverage,complete}')::boolean, FALSE)
             AS trade_coverage_complete,
           EXTRACT(EPOCH FROM (NOW() - pool.created_at)) / 60 AS pool_age_minutes
         FROM pools pool
         LEFT JOIN tokens token
           ON token.chain = pool.chain AND token.address = pool.base_token_address
         JOIN LATERAL (
           SELECT assessment.risk_score, assessment.confidence, assessment.warnings,
                  assessment.sub_scores, assessment.calculated_at
           FROM token_risk_assessments assessment
           WHERE assessment.chain = pool.chain
             AND assessment.token_address = pool.base_token_address
           ORDER BY assessment.calculated_at DESC
           LIMIT 1
         ) risk ON true
         WHERE pool.chain = 'solana'
           AND pool.created_at >= GREATEST(
             $1::timestamptz,
             NOW() - make_interval(mins => $2::integer)
           )
           AND pool.base_token_address <> ALL($5::text[])
           AND pool.liquidity_usd >= $3::numeric
           AND pool.volume_5m_usd >= $4::numeric
       ), assessed AS MATERIALIZED (
         SELECT recent.*,
                recent.buys_5m + recent.sells_5m AS transactions_5m,
                recent.buys_5m::numeric /
                  GREATEST(recent.buys_5m + recent.sells_5m, 1) AS buy_share_5m,
                recent.volume_5m_usd / GREATEST(recent.liquidity_usd, 1)
                  AS volume_liquidity_ratio,
                recent.risk_score = 0
                  AND recent.confidence >= $12::numeric
                  AND jsonb_typeof(recent.warnings) = 'array'
                  AND jsonb_array_length(recent.warnings) = 0
                  AND recent.risk_assessed_at >= recent.created_at - INTERVAL '1 minute'
                  AS risk_passed
         FROM recent_pools recent
       ), strict_matches AS MATERIALIZED (
         SELECT assessed.*,
                ROW_NUMBER() OVER (
                  PARTITION BY assessed.base_token_address
                  ORDER BY assessed.liquidity_usd DESC, assessed.pool_address
                ) AS token_pool_rank
         FROM assessed
         WHERE assessed.risk_passed
           AND assessed.pool_age_minutes >= $6::numeric
           AND assessed.transactions_5m >= $7::integer
           AND assessed.buy_share_5m >= $8::numeric
           AND assessed.buy_share_5m < $9::numeric
           AND assessed.volume_liquidity_ratio < $10::numeric
           AND assessed.top10_holder_percent < $11::numeric
           AND assessed.trade_coverage_complete
           AND NOT EXISTS (
             SELECT 1
             FROM ingestion_coverage_incidents incident
             WHERE incident.chain = assessed.chain
               AND incident.coverage_reconciled_at IS NULL
               AND incident.program_address = assessed.dex
               AND assessed.created_at >= incident.gap_started_at
               AND assessed.created_at <= COALESCE(
                 incident.closed_at,
                 'infinity'::timestamptz
               )
           )
       ), candidates AS (
         SELECT strict.*
         FROM strict_matches strict
         WHERE strict.token_pool_rank = 1
           AND NOT EXISTS (
             SELECT 1
             FROM telegram_notification_outbox existing
             WHERE existing.event_type = 'qualified-pool'
               AND existing.source_key = $13::text || ':' || strict.base_token_address
           )
         ORDER BY strict.created_at, strict.pool_address
         LIMIT 100
       ), inserted AS (
         INSERT INTO telegram_notification_outbox (
           id, event_type, source_key, payload, status
         )
         SELECT
           'qualified-pool:' || $13::text || ':' || candidate.base_token_address,
           'qualified-pool',
           $13::text || ':' || candidate.base_token_address,
           jsonb_strip_nulls(jsonb_build_object(
             'qualificationVersion', $13::text,
             'researchMode', $14::text,
             'parentQualificationVersion', $15::text,
             'tokenAddress', candidate.base_token_address,
             'poolAddress', candidate.pool_address,
             'tokenSymbol', candidate.token_symbol,
             'tokenName', candidate.token_name,
             'dex', candidate.dex,
             'createdAt', candidate.created_at,
             'liquidityUsd', candidate.liquidity_usd,
             'volume5mUsd', candidate.volume_5m_usd,
             'priceUsd', candidate.price_usd,
             'marketCapUsd', candidate.market_cap_usd,
             'riskScore', candidate.risk_score,
             'riskConfidence', candidate.confidence,
             'riskAssessedAt', candidate.risk_assessed_at,
             'poolAgeMinutes', candidate.pool_age_minutes,
             'buys5m', candidate.buys_5m,
             'sells5m', candidate.sells_5m,
             'transactions5m', candidate.transactions_5m,
             'buyShare5m', candidate.buy_share_5m,
             'volumeLiquidityRatio', candidate.volume_liquidity_ratio,
             'top10HolderPercent', candidate.top10_holder_percent,
             'tradeCoverageComplete', candidate.trade_coverage_complete
           )),
           $16::text
         FROM candidates candidate
         ON CONFLICT (event_type, source_key) DO NOTHING
         RETURNING 1
       )
       SELECT
         (SELECT COUNT(*)::integer FROM recent_pools) AS scanned_pool_count,
         (SELECT COUNT(*)::integer FROM assessed WHERE risk_passed) AS risk_passed_pool_count,
         (SELECT COUNT(*)::integer FROM strict_matches WHERE token_pool_rank = 1)
           AS strict_candidate_count,
         (SELECT COUNT(*)::integer FROM inserted) AS inserted`,
      [
        options.startedAt,
        Math.max(5, Math.trunc(options.maxAgeMinutes)),
        Math.max(0, options.minimumLiquidityUsd),
        Math.max(0, options.minimumVolume5mUsd),
        options.excludedTokenAddresses,
        policy.minimumPoolAgeMinutes,
        policy.minimumTransactions5m,
        policy.minimumBuyShare5m,
        policy.maximumBuyShare5mExclusive,
        policy.maximumVolumeLiquidityRatioExclusive,
        policy.maximumTop10HolderPercentExclusive,
        policy.minimumRiskConfidence,
        qualificationVersion,
        deliveryMode,
        policy.version,
        deliveryMode === "shadow" ? "shadow" : "pending"
      ]
    );
    const row = result.rows[0];
    return {
      scannedPoolCount: Number(row?.scanned_pool_count ?? 0),
      riskPassedPoolCount: Number(row?.risk_passed_pool_count ?? 0),
      strictCandidateCount: Number(row?.strict_candidate_count ?? 0),
      inserted: Number(row?.inserted ?? 0)
    };
  }

  async getPipelineStatus(walletAlphaStrategyVersion: string): Promise<PipelineStatusNotification> {
    const normalizedStrategyVersion = walletAlphaStrategyVersion.trim();
    if (!normalizedStrategyVersion) {
      throw new Error("Wallet-alpha strategy version is required for pipeline status.");
    }
    const result = await this.pool.query<{
      checked_at: string;
      inbox_backlog: number;
      dead_letters: number;
      alpha_queue_pending: number;
      signals_24h: number;
      qualified_pools_24h: number;
      last_pool_age_seconds: number | null;
      last_wallet_trade_age_seconds: number | null;
      database_bytes: string;
      open_coverage_incident_count: number;
      open_coverage_incidents: unknown;
    }>(
      `WITH open_coverage AS MATERIALIZED (
         SELECT
           idempotency_key,
           program_address,
           provider,
           reason,
           gap_started_at,
           opened_at,
           cluster_slot,
           source_slot,
           slot_lag,
           silence_ms
         FROM ingestion_coverage_incidents
         WHERE closed_at IS NULL
         ORDER BY opened_at, program_address
       )
       SELECT
         NOW() AS checked_at,
         (SELECT COUNT(*)::integer FROM chain_event_inbox
          WHERE status IN ('pending', 'processing', 'retry')) AS inbox_backlog,
         (SELECT COUNT(*)::integer FROM chain_event_inbox
          WHERE status = 'dead_letter') AS dead_letters,
         (SELECT COUNT(*)::integer FROM wallet_alpha_work_queue
          WHERE strategy_version = $2
            AND revision > completed_revision) AS alpha_queue_pending,
         (SELECT COUNT(*)::integer FROM wallet_alpha_signals
          WHERE detected_at >= NOW() - INTERVAL '24 hours') AS signals_24h,
         (SELECT COUNT(*)::integer FROM telegram_notification_outbox
          WHERE event_type = 'qualified-pool'
            AND status = 'delivered'
            AND payload->>'qualificationVersion' = $1
            AND delivered_at >= NOW() - INTERVAL '24 hours') AS qualified_pools_24h,
         (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(occurred_at)))
          FROM chain_event_inbox WHERE event_type = 'pool_created') AS last_pool_age_seconds,
         (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(observed_at)))
          FROM wallet_trade_events) AS last_wallet_trade_age_seconds,
         (SELECT COUNT(*)::integer FROM open_coverage) AS open_coverage_incident_count,
         (SELECT COALESCE(
            jsonb_agg(jsonb_build_object(
              'incidentId', incident.idempotency_key,
              'programAddress', incident.program_address,
              'provider', incident.provider,
              'reason', incident.reason,
              'gapStartedAt', incident.gap_started_at,
              'openedAt', incident.opened_at,
              'clusterSlot', incident.cluster_slot,
              'sourceSlot', incident.source_slot,
              'slotLag', incident.slot_lag,
              'silenceMs', incident.silence_ms,
              'coverageDisposition', 'alpha_excluded_unreconciled'
            ) ORDER BY incident.opened_at, incident.program_address),
            '[]'::jsonb
          ) FROM open_coverage AS incident) AS open_coverage_incidents,
         pg_database_size(current_database())::text AS database_bytes`,
      [strictQualifiedPoolNotificationPolicy.version, normalizedStrategyVersion]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Pipeline status query returned no row.");
    const backlog = Number(row.inbox_backlog);
    const deadLetters = Number(row.dead_letters);
    const lastPoolAgeSeconds = nullableNumber(row.last_pool_age_seconds);
    const lastWalletTradeAgeSeconds = nullableNumber(row.last_wallet_trade_age_seconds);
    const openCoverageIncidentCount = Number(row.open_coverage_incident_count ?? 0);
    const openCoverageIncidents = parseCoverageIncidents(row.open_coverage_incidents);
    const pipelineStatus =
      backlog <= 100 &&
      deadLetters === 0 &&
      openCoverageIncidentCount === 0 &&
      (lastPoolAgeSeconds ?? Number.POSITIVE_INFINITY) <= 300
        ? "ok"
        : "degraded";
    return {
      checkedAt: new Date(row.checked_at).toISOString(),
      pipelineStatus,
      inboxBacklog: backlog,
      deadLetters,
      alphaQueuePending: Number(row.alpha_queue_pending),
      signals24h: Number(row.signals_24h),
      qualifiedPools24h: Number(row.qualified_pools_24h),
      ...(lastPoolAgeSeconds !== undefined ? { lastPoolAgeSeconds } : {}),
      ...(lastWalletTradeAgeSeconds !== undefined ? { lastWalletTradeAgeSeconds } : {}),
      databaseBytes: Number(row.database_bytes),
      openCoverageIncidentCount,
      openCoverageIncidents
    };
  }

  async enqueueCoverageIncidentTransitions(walletAlphaStrategyVersion: string): Promise<number> {
    const transitions = await this.pool.query<{
      idempotency_key: string;
      program_address: string;
      provider: string;
      reason: string;
      gap_started_at: string;
      opened_at: string;
      closed_at: string | null;
      cluster_slot: string | number | null;
      source_slot: string | number | null;
      slot_lag: string | number | null;
      silence_ms: string | number | null;
      transition: "opened" | "transport-recovered" | "coverage-reconciled";
      transition_at: string;
    }>(
      `WITH transitions AS (
         SELECT
           incident.*,
           'opened'::text AS transition,
           incident.opened_at AS transition_at,
           'coverage-incident:opened:' || incident.idempotency_key AS source_key
         FROM ingestion_coverage_incidents AS incident
         UNION ALL
         SELECT
           incident.*,
           CASE
             WHEN incident.coverage_reconciled_at IS NOT NULL THEN 'coverage-reconciled'::text
             ELSE 'transport-recovered'::text
           END AS transition,
           incident.closed_at AS transition_at,
           'coverage-incident:' ||
             CASE
               WHEN incident.coverage_reconciled_at IS NOT NULL THEN 'coverage-reconciled'
               ELSE 'transport-recovered'
             END || ':' || incident.idempotency_key AS source_key
         FROM ingestion_coverage_incidents AS incident
         WHERE incident.closed_at IS NOT NULL
       ), latest_by_program AS (
         -- A stopped notifier may miss many open/recovered cycles for one
         -- unhealthy program. Resume from its latest durable state instead of
         -- replaying every historical transition into Telegram. While running,
         -- a later close or a new incident naturally becomes the new latest row.
         SELECT DISTINCT ON (program_address) *
         FROM transitions
         ORDER BY
           program_address,
           transition_at DESC,
           transition DESC,
           idempotency_key DESC
       )
       SELECT latest.*
       FROM latest_by_program AS latest
       WHERE NOT EXISTS (
         SELECT 1 FROM telegram_notification_outbox AS message
         WHERE message.event_type = 'status'
           AND message.source_key = latest.source_key
       )
       ORDER BY transition_at, idempotency_key
       LIMIT 20`
    );
    let inserted = 0;
    for (const row of transitions.rows) {
      const status = await this.getPipelineStatus(walletAlphaStrategyVersion);
      const transition: IngestionCoverageIncidentTransition = {
        incidentId: row.idempotency_key,
        programAddress: row.program_address,
        provider: row.provider,
        reason: row.reason,
        gapStartedAt: new Date(row.gap_started_at).toISOString(),
        openedAt: new Date(row.opened_at).toISOString(),
        transition: row.transition,
        transitionAt: new Date(row.transition_at).toISOString(),
        ...(row.cluster_slot !== null ? { clusterSlot: Number(row.cluster_slot) } : {}),
        ...(row.source_slot !== null ? { sourceSlot: Number(row.source_slot) } : {}),
        ...(row.slot_lag !== null ? { slotLag: Number(row.slot_lag) } : {}),
        ...(row.silence_ms !== null ? { silenceMs: Number(row.silence_ms) } : {}),
        coverageDisposition:
          row.transition === "coverage-reconciled"
            ? "reconciled"
            : "alpha_excluded_unreconciled"
      };
      const sourceKey = `coverage-incident:${row.transition}:${row.idempotency_key}`;
      if (await this.enqueueStatus(sourceKey, { ...status, coverageTransition: transition })) {
        inserted += 1;
      }
    }
    return inserted;
  }

  async enqueueStatus(sourceKey: string, payload: PipelineStatusNotification): Promise<boolean> {
    const id = createHash("sha256").update(`status:${sourceKey}`).digest("hex");
    const result = await this.pool.query(
      `INSERT INTO telegram_notification_outbox (id, event_type, source_key, payload)
       VALUES ($1, 'status', $2, $3::jsonb)
       ON CONFLICT (event_type, source_key) DO NOTHING`,
      [id, sourceKey, JSON.stringify(payload)]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async enqueuePaperTrade(sourceKey: string, payload: PaperTradeNotification): Promise<boolean> {
    const id = createHash("sha256").update(`paper-trade:${sourceKey}`).digest("hex");
    const result = await this.pool.query(
      `INSERT INTO telegram_notification_outbox (id, event_type, source_key, payload)
       VALUES ($1, 'paper-trade', $2, $3::jsonb)
       ON CONFLICT (event_type, source_key) DO NOTHING`,
      [id, sourceKey, JSON.stringify(payload)]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async claim(options: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<TelegramNotificationMessage[]> {
    const result = await this.pool.query(
      `WITH eligible_qualified AS MATERIALIZED (
         SELECT message.id
         FROM telegram_notification_outbox message
         JOIN pools pool
           ON pool.chain = 'solana'
          AND pool.pool_address = message.payload->>'poolAddress'
          AND pool.base_token_address = message.payload->>'tokenAddress'
          AND pool.created_at IS NOT NULL
         WHERE message.event_type = 'qualified-pool'
           AND message.payload->>'qualificationVersion' = $4
           AND (
             (message.status IN ('pending', 'retry') AND message.available_at <= NOW())
             OR (message.status = 'processing' AND message.lock_expires_at <= NOW())
           )
           AND NOT EXISTS (
             SELECT 1
             FROM ingestion_coverage_incidents incident
             WHERE incident.chain = pool.chain
               AND incident.coverage_reconciled_at IS NULL
               AND incident.program_address = pool.dex
               AND pool.created_at >= incident.gap_started_at
               AND pool.created_at <= COALESCE(
                 incident.closed_at,
                 'infinity'::timestamptz
               )
           )
       ), tainted AS MATERIALIZED (
         SELECT message.id
         FROM telegram_notification_outbox message
         WHERE message.event_type = 'qualified-pool'
           AND (
             (message.status IN ('pending', 'retry') AND message.available_at <= NOW())
             OR (message.status = 'processing' AND message.lock_expires_at <= NOW())
           )
           AND NOT EXISTS (
             SELECT 1
             FROM eligible_qualified eligible
             WHERE eligible.id = message.id
           )
         ORDER BY message.created_at, message.id
         FOR UPDATE SKIP LOCKED
         LIMIT 20
       ), suppressed AS (
         UPDATE telegram_notification_outbox message
         SET status = 'suppressed',
             locked_by = NULL,
             locked_at = NULL,
             lock_expires_at = NULL,
             last_error = 'discovery_coverage_unreconciled'
         FROM tainted
         WHERE message.id = tainted.id
         RETURNING message.id
       ), candidates AS (
         SELECT id
         FROM telegram_notification_outbox
         WHERE (
           (status IN ('pending', 'retry') AND available_at <= NOW())
           OR (status = 'processing' AND lock_expires_at <= NOW())
         )
           AND (
             event_type <> 'qualified-pool'
             OR EXISTS (
               SELECT 1
               FROM eligible_qualified eligible
               WHERE eligible.id = telegram_notification_outbox.id
             )
           )
           AND NOT EXISTS (SELECT 1 FROM suppressed WHERE suppressed.id = telegram_notification_outbox.id)
         ORDER BY
           CASE
             WHEN event_type = 'status' AND source_key LIKE 'coverage-incident:%' THEN 0
             WHEN event_type = 'qualified-pool' THEN 1
             ELSE 2
           END,
           created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE telegram_notification_outbox message
       SET status = 'processing',
           attempt_count = message.attempt_count + 1,
           locked_by = $2,
           locked_at = NOW(),
           lock_expires_at = NOW() + ($3 * INTERVAL '1 second'),
           last_error = NULL
       FROM candidates
       WHERE message.id = candidates.id
       RETURNING message.*`,
      [
        Math.max(1, Math.min(20, Math.trunc(options.limit))),
        options.workerId,
        options.leaseSeconds,
        strictQualifiedPoolNotificationPolicy.version
      ]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      eventType: row.event_type as TelegramNotificationEventType,
      sourceKey: String(row.source_key),
      payload: row.payload as
        QualifiedPoolNotification | PipelineStatusNotification | PaperTradeNotification,
      attemptCount: Number(row.attempt_count)
    }));
  }

  async complete(id: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE telegram_notification_outbox
       SET status = 'delivered', delivered_at = NOW(),
           locked_by = NULL, locked_at = NULL, lock_expires_at = NULL, last_error = NULL
       WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
      [id, workerId]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async suppressClaimedCoverageTainted(id: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE telegram_notification_outbox message
       SET status = 'suppressed',
           locked_by = NULL,
           locked_at = NULL,
           lock_expires_at = NULL,
           last_error = 'discovery_coverage_unreconciled'
       WHERE message.id = $1
         AND message.status = 'processing'
         AND message.locked_by = $2
         AND message.event_type = 'qualified-pool'
         AND NOT EXISTS (
           SELECT 1
           FROM pools pool
            WHERE pool.chain = 'solana'
              AND pool.pool_address = message.payload->>'poolAddress'
              AND pool.base_token_address = message.payload->>'tokenAddress'
              AND pool.created_at IS NOT NULL
              AND message.payload->>'qualificationVersion' = $3
             AND NOT EXISTS (
               SELECT 1
               FROM ingestion_coverage_incidents incident
               WHERE incident.chain = pool.chain
                 AND incident.coverage_reconciled_at IS NULL
                 AND incident.program_address = pool.dex
                 AND pool.created_at >= incident.gap_started_at
                 AND pool.created_at <= COALESCE(
                   incident.closed_at,
                   'infinity'::timestamptz
                 )
             )
         )
       RETURNING message.id`,
      [id, workerId, strictQualifiedPoolNotificationPolicy.version]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async fail(
    id: string,
    workerId: string,
    error: string,
    options: { maxAttempts: number; retryAt: string }
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE telegram_notification_outbox
       SET status = CASE WHEN attempt_count >= $4 THEN 'dead_letter' ELSE 'retry' END,
           available_at = $5,
           locked_by = NULL, locked_at = NULL, lock_expires_at = NULL,
           last_error = $3
       WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
      [id, workerId, error, options.maxAttempts, options.retryAt]
    );
    return (result.rowCount ?? 0) === 1;
  }
}

function nullableNumber(value: number | null): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCoverageIncidents(value: unknown): IngestionCoverageIncidentStatus[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.incidentId !== "string" ||
      typeof record.programAddress !== "string" ||
      typeof record.provider !== "string" ||
      typeof record.reason !== "string" ||
      typeof record.gapStartedAt !== "string" ||
      typeof record.openedAt !== "string"
    ) {
      return [];
    }
    return [
      {
        incidentId: record.incidentId,
        programAddress: record.programAddress,
        provider: record.provider,
        reason: record.reason,
        gapStartedAt: new Date(record.gapStartedAt).toISOString(),
        openedAt: new Date(record.openedAt).toISOString(),
        ...(nullableNumber(record.clusterSlot as number | null) !== undefined
          ? { clusterSlot: Number(record.clusterSlot) }
          : {}),
        ...(nullableNumber(record.sourceSlot as number | null) !== undefined
          ? { sourceSlot: Number(record.sourceSlot) }
          : {}),
        ...(nullableNumber(record.slotLag as number | null) !== undefined
          ? { slotLag: Number(record.slotLag) }
          : {}),
        ...(nullableNumber(record.silenceMs as number | null) !== undefined
          ? { silenceMs: Number(record.silenceMs) }
          : {}),
        coverageDisposition: "alpha_excluded_unreconciled" as const
      }
    ];
  });
}
