import { createHash } from "node:crypto";
import type pg from "pg";
import type {
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

  async enqueueQualifiedPools(options: QualifiedPoolScanOptions): Promise<number> {
    const result = await this.pool.query<{ inserted: number }>(
      `WITH candidates AS (
         SELECT
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
           risk.confidence
         FROM pools pool
         LEFT JOIN tokens token
           ON token.chain = pool.chain AND token.address = pool.base_token_address
         JOIN LATERAL (
           SELECT assessment.risk_score, assessment.confidence, assessment.warnings
           FROM token_risk_assessments assessment
           WHERE assessment.chain = pool.chain
             AND assessment.token_address = pool.base_token_address
           ORDER BY assessment.calculated_at DESC
           LIMIT 1
         ) risk ON true
         WHERE pool.created_at >= GREATEST(
             $1::timestamptz,
             NOW() - make_interval(mins => $2::integer)
           )
           AND pool.base_token_address <> ALL($5::text[])
           AND pool.liquidity_usd >= $3::numeric
           AND pool.volume_5m_usd >= $4::numeric
           AND risk.confidence > 0
           AND jsonb_array_length(risk.warnings) = 0
           AND NOT EXISTS (
             SELECT 1
             FROM telegram_notification_outbox existing
             WHERE existing.event_type = 'qualified-pool'
               AND existing.source_key = pool.pool_address
           )
         ORDER BY pool.created_at, pool.pool_address
         LIMIT 100
       ), inserted AS (
         INSERT INTO telegram_notification_outbox (
           id, event_type, source_key, payload
         )
         SELECT
           'qualified-pool:' || candidate.pool_address,
           'qualified-pool',
           candidate.pool_address,
           jsonb_strip_nulls(jsonb_build_object(
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
             'riskConfidence', candidate.confidence
           ))
         FROM candidates candidate
         ON CONFLICT (event_type, source_key) DO NOTHING
         RETURNING 1
       )
       SELECT COUNT(*)::integer AS inserted FROM inserted`,
      [
        options.startedAt,
        Math.max(5, Math.trunc(options.maxAgeMinutes)),
        Math.max(0, options.minimumLiquidityUsd),
        Math.max(0, options.minimumVolume5mUsd),
        options.excludedTokenAddresses
      ]
    );
    return Number(result.rows[0]?.inserted ?? 0);
  }

  async getPipelineStatus(): Promise<PipelineStatusNotification> {
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
    }>(
      `SELECT
         NOW() AS checked_at,
         (SELECT COUNT(*)::integer FROM chain_event_inbox
          WHERE status IN ('pending', 'processing', 'retry')) AS inbox_backlog,
         (SELECT COUNT(*)::integer FROM chain_event_inbox
          WHERE status = 'dead_letter') AS dead_letters,
         (SELECT COUNT(*)::integer FROM wallet_alpha_work_queue
          WHERE revision > completed_revision) AS alpha_queue_pending,
         (SELECT COUNT(*)::integer FROM wallet_alpha_signals
          WHERE detected_at >= NOW() - INTERVAL '24 hours') AS signals_24h,
         (SELECT COUNT(*)::integer FROM telegram_notification_outbox
          WHERE event_type = 'qualified-pool'
            AND status = 'delivered'
            AND delivered_at >= NOW() - INTERVAL '24 hours') AS qualified_pools_24h,
         (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(occurred_at)))
          FROM chain_event_inbox WHERE event_type = 'pool_created') AS last_pool_age_seconds,
         (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(observed_at)))
          FROM wallet_trade_events) AS last_wallet_trade_age_seconds,
         pg_database_size(current_database())::text AS database_bytes`
    );
    const row = result.rows[0];
    if (!row) throw new Error("Pipeline status query returned no row.");
    const backlog = Number(row.inbox_backlog);
    const deadLetters = Number(row.dead_letters);
    const lastPoolAgeSeconds = nullableNumber(row.last_pool_age_seconds);
    const lastWalletTradeAgeSeconds = nullableNumber(row.last_wallet_trade_age_seconds);
    const pipelineStatus =
      backlog <= 100 && deadLetters === 0 && (lastPoolAgeSeconds ?? Number.POSITIVE_INFINITY) <= 300
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
      databaseBytes: Number(row.database_bytes)
    };
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
      `WITH candidates AS (
         SELECT id
         FROM telegram_notification_outbox
         WHERE (
           (status IN ('pending', 'retry') AND available_at <= NOW())
           OR (status = 'processing' AND lock_expires_at <= NOW())
         )
         ORDER BY CASE event_type WHEN 'qualified-pool' THEN 0 ELSE 1 END, created_at
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
      [Math.max(1, Math.min(20, Math.trunc(options.limit))), options.workerId, options.leaseSeconds]
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
