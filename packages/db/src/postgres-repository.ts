import { createHash } from "node:crypto";
import pg from "pg";
import type {
  BacktestRun,
  ChainId,
  HistoricalBackfillWindow,
  HistoricalMarketObservation,
  HypothesisRunEvidence,
  IngestionCursorEvidence,
  OnchainSwapEvidence,
  PaperTrade,
  PoolSnapshot,
  PriceObservationEvidence,
  ProviderStatus,
  Signal,
  TokenSnapshot,
  WalletEntrySignalEvidence,
  WalletAlphaScoreSnapshot,
  WalletAlphaSignalEvidence,
  WalletSignalOutcomeEvidence,
  WalletTradeEvidence,
  WalletScore
} from "@memecoin-alpha/shared";
import type {
  CanonicalChainEvent,
  CanonicalChainEventInput,
  CanonicalEventClaimOptions,
  CanonicalEventFailureOptions,
  CanonicalEventFailureResult,
  CanonicalRepository,
  DurableSolanaSignature,
  DurableSolanaSignatureQueueSummary,
  EvidenceRepository,
  IngestionGapRepair,
  IngestionGapRepairCreateInput,
  IngestionGapRepairPageInput,
  IngestionGapRepairSignature,
  IngestionCoverageIncident,
  IngestionCoverageIncidentCloseInput,
  IngestionCoverageIncidentOpenInput,
  IntelligenceRepository,
  PipelineHealthSummary,
  PipelineWatermark,
  QuotePriceObservation,
  SignalOutboxClaimOptions,
  SignalOutboxFailureOptions,
  SignalOutboxMessage,
  SolanaFinalityBatchResult,
  SolanaFinalityResult,
  SolanaFinalityWorkItem,
  TokenRiskReport,
  WalletAlphaCoverageSummary,
  WalletAlphaAdmissionProbe,
  WalletAlphaDetail,
  WalletAlphaRankingQuery,
  WalletAlphaSignalQuery,
  WalletAlphaStatusCounts,
  WalletAlphaWorkClaimOptions,
  WalletAlphaWorkCandidate,
  WalletAlphaWorkItem,
  WalletAlphaWorkPriority,
  WalletAlphaWorkSummary,
  WalletPositionEpisode,
  WalletPositionLedgerSnapshot,
  WalletPositionLedgerWriteResult,
  WalletPositionLot
} from "./repository";
import { assertWalletPositionLedgerSnapshot, classifyWalletAlphaEntryWork } from "./repository";

const { Pool } = pg;

interface Queryable {
  query: pg.Pool["query"];
  connect?: () => Promise<TransactionClient>;
}

interface TransactionClient {
  query: pg.Pool["query"];
  release: () => void;
}

const POSTGRES_JSON_NUL_MARKER = "_walletscanerPayloadEncoding";

function encodePostgresJsonPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!containsPostgresJsonNul(payload)) return payload;
  const originalJson = JSON.stringify(payload);
  const sanitized = sanitizePostgresJsonValue(payload);
  return {
    ...(sanitized.value as Record<string, unknown>),
    [POSTGRES_JSON_NUL_MARKER]: {
      version: "postgres-json-nul-v1",
      replacement: "literal-\\u0000",
      occurrenceCount: sanitized.nulCount,
      originalPayloadSha256: createHash("sha256").update(originalJson).digest("hex")
    }
  };
}

function containsPostgresJsonNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(containsPostgresJsonNul);
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) => key.includes("\u0000") || containsPostgresJsonNul(item)
    );
  }
  return false;
}

function sanitizePostgresJsonValue(value: unknown): { value: unknown; nulCount: number } {
  if (typeof value === "string") {
    const parts = value.split("\u0000");
    return {
      value: parts.join("\\u0000"),
      nulCount: parts.length - 1
    };
  }
  if (Array.isArray(value)) {
    let nulCount = 0;
    const sanitized = value.map((item) => {
      const result = sanitizePostgresJsonValue(item);
      nulCount += result.nulCount;
      return result.value;
    });
    return { value: sanitized, nulCount };
  }
  if (value && typeof value === "object") {
    let nulCount = 0;
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = sanitizePostgresJsonValue(item);
      const keyParts = key.split("\u0000");
      sanitized[keyParts.join("\\u0000")] = result.value;
      nulCount += result.nulCount + keyParts.length - 1;
    }
    return { value: sanitized, nulCount };
  }
  return { value, nulCount: 0 };
}

export class PostgresRepository
  implements IntelligenceRepository, EvidenceRepository, CanonicalRepository
{
  private readonly pool: Queryable;

  constructor(databaseUrl: string | Queryable) {
    this.pool =
      typeof databaseUrl === "string" ? new Pool({ connectionString: databaseUrl }) : databaseUrl;
  }

  private async withTransaction<T>(
    operation: (client: TransactionClient) => Promise<T>
  ): Promise<T> {
    if (!this.pool.connect) {
      throw new Error("This repository connection does not support transactions.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertToken(token: TokenSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO tokens (chain, address, symbol, name, decimals, creator_address, first_seen_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (chain, address) DO UPDATE SET
         symbol = EXCLUDED.symbol,
         name = EXCLUDED.name,
         decimals = EXCLUDED.decimals,
         creator_address = EXCLUDED.creator_address,
         metadata = tokens.metadata || EXCLUDED.metadata`,
      [
        token.chain,
        token.address,
        token.symbol,
        token.name,
        token.decimals ?? null,
        token.creatorAddress ?? null,
        token.firstSeenAt,
        token.metadata
      ]
    );
  }

  async upsertPool(pool: PoolSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO pools (
         chain, pool_address, dex, base_token_address, quote_token_address,
         created_at, liquidity_usd, token_symbol, token_name, volume_5m_usd,
         price_usd, market_cap_usd, raw
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (chain, pool_address) DO UPDATE SET
         liquidity_usd = EXCLUDED.liquidity_usd,
         token_symbol = COALESCE(EXCLUDED.token_symbol, pools.token_symbol),
         token_name = COALESCE(EXCLUDED.token_name, pools.token_name),
         volume_5m_usd = EXCLUDED.volume_5m_usd,
         price_usd = COALESCE(EXCLUDED.price_usd, pools.price_usd),
         market_cap_usd = COALESCE(EXCLUDED.market_cap_usd, pools.market_cap_usd),
         raw = EXCLUDED.raw`,
      [
        pool.chain,
        pool.poolAddress,
        pool.dex,
        pool.baseTokenAddress,
        pool.quoteTokenAddress ?? null,
        pool.createdAt ?? null,
        pool.liquidityUsd,
        pool.tokenSymbol ?? null,
        pool.tokenName ?? null,
        pool.volume5mUsd,
        pool.priceUsd ?? null,
        pool.marketCapUsd ?? null,
        pool.raw ?? {}
      ]
    );
  }

  async saveSignal(signal: Signal): Promise<void> {
    await this.pool.query(
      `INSERT INTO signals (
        id, strategy_version, chain, token_address, pool_address, signal_type, confidence, risk_score, token_score,
        action_category, detected_at, key_reasons, wallets, liquidity_snapshot, volume_snapshot, holder_snapshot, raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (id) DO UPDATE SET
        confidence = EXCLUDED.confidence,
        risk_score = EXCLUDED.risk_score,
        token_score = EXCLUDED.token_score,
        action_category = EXCLUDED.action_category,
        raw = EXCLUDED.raw`,
      [
        signal.id,
        signal.strategyVersion,
        signal.chain,
        signal.tokenAddress,
        signal.poolAddress ?? null,
        signal.signalType,
        signal.confidence,
        signal.riskScore,
        signal.tokenScore,
        signal.actionCategory,
        signal.detectedAt,
        JSON.stringify(signal.keyReasons),
        JSON.stringify(signal.wallets),
        signal.liquiditySnapshot,
        signal.volumeSnapshot,
        signal.holderSnapshot,
        signal
      ]
    );
  }

  async saveWalletScore(score: WalletScore): Promise<void> {
    await this.pool.query(
      `INSERT INTO wallet_scores (chain, wallet_address, score, category, calculated_at, features, reasons)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chain, wallet_address, calculated_at) DO NOTHING`,
      [
        score.chain,
        score.walletAddress,
        score.score,
        score.category,
        score.calculatedAt,
        score.features,
        JSON.stringify(score.reasons)
      ]
    );
  }

  async saveTokenRisk(report: TokenRiskReport): Promise<void> {
    await this.pool.query(
      `INSERT INTO token_risk_assessments (
        chain, token_address, calculated_at, score, risk_score, confidence, sub_scores, reasons, warnings
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (chain, token_address, calculated_at) DO NOTHING`,
      [
        report.chain,
        report.tokenAddress,
        report.calculatedAt,
        report.score.score,
        report.score.riskScore,
        report.score.confidence,
        report.score.subScores,
        JSON.stringify(report.score.reasons),
        JSON.stringify(report.score.warnings)
      ]
    );
  }

  async savePaperTrade(trade: PaperTrade): Promise<void> {
    await this.pool.query(
      `INSERT INTO paper_trades (
        id, signal_id, strategy_version, chain, token_address, side, status, quantity, price_usd, notional_usd,
        fees_usd, slippage_bps, opened_at, closed_at, pnl_usd, reason, raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (id) DO UPDATE SET
        signal_id = EXCLUDED.signal_id,
        strategy_version = EXCLUDED.strategy_version,
        chain = EXCLUDED.chain,
        token_address = EXCLUDED.token_address,
        side = EXCLUDED.side,
        status = EXCLUDED.status,
        quantity = EXCLUDED.quantity,
        price_usd = EXCLUDED.price_usd,
        notional_usd = EXCLUDED.notional_usd,
        fees_usd = EXCLUDED.fees_usd,
        slippage_bps = EXCLUDED.slippage_bps,
        opened_at = EXCLUDED.opened_at,
        closed_at = EXCLUDED.closed_at,
        pnl_usd = EXCLUDED.pnl_usd,
        reason = EXCLUDED.reason,
        raw = EXCLUDED.raw`,
      [
        trade.id,
        trade.signalId,
        trade.strategyVersion,
        trade.chain,
        trade.tokenAddress,
        trade.side,
        trade.status,
        trade.quantity,
        trade.priceUsd,
        trade.notionalUsd,
        trade.feesUsd,
        trade.slippageBps,
        trade.openedAt,
        trade.closedAt ?? null,
        trade.pnlUsd ?? null,
        trade.reason,
        trade.raw ?? trade
      ]
    );
  }

  async saveBacktestRun(run: BacktestRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO backtest_runs (
        id, strategy_version, started_at, finished_at, date_start, date_end, config, metrics, report_markdown
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET finished_at = EXCLUDED.finished_at, metrics = EXCLUDED.metrics, report_markdown = EXCLUDED.report_markdown`,
      [
        run.id,
        run.strategyVersion,
        run.startedAt,
        run.finishedAt,
        run.dateStart,
        run.dateEnd,
        run.config,
        run.metrics,
        run.reportMarkdown
      ]
    );
  }

  async listRecentTokens(limit = 50): Promise<TokenSnapshot[]> {
    const result = await this.pool.query(
      `SELECT * FROM tokens ORDER BY first_seen_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map(rowToToken);
  }

  async listTokenCreatorAddresses(): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT creator_address
       FROM tokens
       WHERE creator_address IS NOT NULL
         AND creator_address <> ''`
    );
    return result.rows.map((row) => String(row.creator_address));
  }

  async listMatchingTokenCreatorAddresses(walletAddresses: string[]): Promise<string[]> {
    if (walletAddresses.length === 0) return [];
    const result = await this.pool.query(
      `SELECT DISTINCT creator_address
       FROM tokens
       WHERE creator_address = ANY($1::text[])
         AND creator_address IS NOT NULL
         AND creator_address <> ''`,
      [walletAddresses]
    );
    return result.rows.map((row) => String(row.creator_address));
  }

  async listRecentPools(limit = 1_000): Promise<PoolSnapshot[]> {
    const result = await this.pool.query(
      `SELECT * FROM pools ORDER BY created_at DESC NULLS LAST LIMIT $1`,
      [limit]
    );
    return result.rows.map(rowToPool);
  }

  async getPool(chain: ChainId, poolAddress: string): Promise<PoolSnapshot | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM pools WHERE chain = $1 AND pool_address = $2`,
      [chain, poolAddress]
    );
    const row = result.rows[0];
    return row ? rowToPool(row) : undefined;
  }

  async getToken(chain: ChainId, address: string): Promise<TokenSnapshot | undefined> {
    const result = await this.pool.query(`SELECT * FROM tokens WHERE chain = $1 AND address = $2`, [
      chain,
      address
    ]);
    const row = result.rows[0];
    return row ? rowToToken(row) : undefined;
  }

  async getTokenRisk(chain: ChainId, address: string): Promise<TokenRiskReport | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM token_risk_assessments
       WHERE chain = $1 AND token_address = $2
       ORDER BY calculated_at DESC LIMIT 1`,
      [chain, address]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      chain: row.chain,
      tokenAddress: row.token_address,
      calculatedAt: new Date(row.calculated_at).toISOString(),
      score: {
        score: Number(row.score),
        riskScore: Number(row.risk_score),
        confidence: Number(row.confidence),
        subScores: row.sub_scores,
        reasons: row.reasons,
        warnings: row.warnings
      }
    };
  }

  async listSignals(limit = 100): Promise<Signal[]> {
    const result = await this.pool.query(
      `SELECT raw FROM signals ORDER BY detected_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => row.raw as Signal);
  }

  async listWalletRankings(limit = 100): Promise<WalletScore[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT ON (wallet_address) features, reasons, chain, wallet_address, score, category, calculated_at
       FROM wallet_scores
       ORDER BY wallet_address, calculated_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(rowToWalletScore).sort((a, b) => b.score - a.score);
  }

  async getWallet(address: string): Promise<WalletScore | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM wallet_scores WHERE wallet_address = $1 ORDER BY calculated_at DESC LIMIT 1`,
      [address]
    );
    const row = result.rows[0];
    return row ? rowToWalletScore(row) : undefined;
  }

  async listPaperTrades(limit = 100): Promise<PaperTrade[]> {
    const result = await this.pool.query(
      `SELECT * FROM paper_trades ORDER BY opened_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => rowToPaperTrade(row));
  }

  async listBacktestRuns(limit = 25): Promise<BacktestRun[]> {
    const result = await this.pool.query(
      `SELECT * FROM backtest_runs ORDER BY started_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      id: row.id,
      strategyVersion: row.strategy_version,
      startedAt: new Date(row.started_at).toISOString(),
      finishedAt: new Date(row.finished_at).toISOString(),
      dateStart: new Date(row.date_start).toISOString(),
      dateEnd: new Date(row.date_end).toISOString(),
      config: row.config,
      metrics: row.metrics,
      reportMarkdown: row.report_markdown
    }));
  }

  async listProviderStatus(): Promise<ProviderStatus[]> {
    return [
      {
        provider: "postgres",
        status: "ok",
        checkedAt: new Date().toISOString(),
        message: "Repository connection is active."
      }
    ];
  }

  async savePriceObservation(observation: PriceObservationEvidence): Promise<boolean> {
    const result = await this.pool.query(
      `WITH accepted AS (
        INSERT INTO price_observation_keys (idempotency_key, observed_at)
        VALUES ($1, $11)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING idempotency_key
      )
      INSERT INTO price_observations (
        idempotency_key, chain, token_address, pool_address, price_usd, liquidity_usd,
        rugged, signature, slot, provider, observed_at, strategy_version, raw
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      FROM accepted
      ON CONFLICT DO NOTHING`,
      [
        observation.idempotencyKey,
        observation.chain,
        observation.tokenAddress,
        observation.poolAddress ?? null,
        observation.priceUsd,
        observation.liquidityUsd,
        observation.rugged,
        observation.signature,
        observation.slot,
        observation.provider,
        observation.observedAt,
        observation.strategyVersion,
        observation.raw
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async saveQuotePriceObservation(observation: QuotePriceObservation): Promise<boolean> {
    const values = [
      observation.idempotencyKey,
      observation.chain,
      observation.quoteTokenAddress,
      observation.priceUsd,
      observation.confidenceUsd,
      observation.source,
      observation.quality,
      observation.publishTime,
      observation.observedAt,
      observation.stalenessSeconds,
      observation.raw
    ];
    const result = await this.pool.query(
      `INSERT INTO quote_price_observations (
        idempotency_key, chain, quote_token_address, price_usd, confidence_usd,
        source, quality, publish_time, observed_at, staleness_seconds, raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT DO NOTHING`,
      values
    );
    if ((result.rowCount ?? 0) > 0) return true;

    // ON CONFLICT may have waited for another transaction. Use a separate statement so its
    // snapshot can see that winner, then distinguish a replay from conflicting oracle evidence.
    // observed_at, staleness_seconds and raw are request/trade context and may legitimately differ
    // when concurrent swaps reuse one source/token/publish-time observation.
    const conflicts = await this.pool.query(
      `SELECT
         idempotency_key = $1 AS idempotency_key_match,
         chain = $2 AS chain_match,
         quote_token_address = $3 AS quote_token_address_match,
         price_usd = $4::numeric AS price_usd_match,
         confidence_usd IS NOT DISTINCT FROM $5::numeric AS confidence_usd_match,
         source = $6 AS source_match,
         quality = $7 AS quality_match,
         publish_time = $8::timestamptz AS publish_time_match
       FROM quote_price_observations
       WHERE idempotency_key = $1
          OR (
            source = $6
            AND quote_token_address = $3
            AND publish_time = $8::timestamptz
          )`,
      values.slice(0, 8)
    );
    const immutableFields = [
      "chain",
      "quote_token_address",
      "price_usd",
      "confidence_usd",
      "source",
      "quality",
      "publish_time"
    ] as const;
    if (
      conflicts.rows.length === 1 &&
      immutableFields.every((field) => conflicts.rows[0]?.[`${field}_match`] === true)
    ) {
      return false;
    }

    const mismatches = new Set<string>();
    for (const row of conflicts.rows) {
      for (const field of immutableFields) {
        if (row[`${field}_match`] !== true) mismatches.add(field);
      }
    }
    throw new Error(
      conflicts.rows.length === 0
        ? "Quote price observation conflict could not be reconciled after insert."
        : `Quote price observation conflicts with stored immutable evidence: ${[...mismatches].join(
            ", "
          )}.`
    );
  }

  async findQuotePriceObservationNear(
    chain: QuotePriceObservation["chain"],
    quoteTokenAddress: string,
    publishTime: string,
    maxDistanceSeconds = 60
  ): Promise<QuotePriceObservation | undefined> {
    const result = await this.pool.query(
      `SELECT *
       FROM quote_price_observations
       WHERE chain = $1
         AND quote_token_address = $2
         AND publish_time BETWEEN
           $3::timestamptz - ($4 * INTERVAL '1 second')
           AND $3::timestamptz + ($4 * INTERVAL '1 second')
       ORDER BY
         ABS(EXTRACT(EPOCH FROM (publish_time - $3::timestamptz))),
         publish_time DESC
       LIMIT 1`,
      [chain, quoteTokenAddress, publishTime, Math.max(1, Math.trunc(maxDistanceSeconds))]
    );
    const row = result.rows[0];
    return row
      ? {
          idempotencyKey: String(row.idempotency_key),
          chain: row.chain,
          quoteTokenAddress: String(row.quote_token_address),
          priceUsd: Number(row.price_usd),
          confidenceUsd: Number(row.confidence_usd),
          source: String(row.source),
          quality: row.quality,
          publishTime: new Date(row.publish_time).toISOString(),
          observedAt: new Date(row.observed_at).toISOString(),
          stalenessSeconds: Number(row.staleness_seconds),
          raw: row.raw ?? {}
        }
      : undefined;
  }

  async saveOnchainSwap(swap: OnchainSwapEvidence): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO swaps (
        idempotency_key, chain, signature, slot, pool_address, trader_address,
        input_token_address, output_token_address, input_amount, output_amount,
        price_usd, volume_usd, observed_at, provider, strategy_version, raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        swap.idempotencyKey,
        swap.chain,
        swap.signature,
        swap.slot,
        swap.poolAddress,
        swap.traderAddress,
        swap.inputTokenAddress,
        swap.outputTokenAddress,
        swap.inputAmount ?? null,
        swap.outputAmount ?? null,
        swap.priceUsd ?? null,
        swap.volumeUsd ?? null,
        swap.observedAt,
        swap.provider,
        swap.strategyVersion,
        swap.raw
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async saveWalletTradeEvent(trade: WalletTradeEvidence): Promise<boolean> {
    const result = await this.pool.query(
      `WITH changed AS (
       INSERT INTO wallet_trade_events (
        idempotency_key, chain, wallet_address, token_address, quote_token_address,
        pool_address, side, base_amount, quote_amount, execution_price_usd,
        quote_value_usd, pool_created_at, pool_age_minutes, data_quality,
        signature, slot, provider, observed_at, strategy_version, raw
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
      )
      ON CONFLICT (idempotency_key) DO UPDATE SET
        execution_price_usd = COALESCE(
          wallet_trade_events.execution_price_usd,
          EXCLUDED.execution_price_usd
        ),
        quote_value_usd = COALESCE(
          wallet_trade_events.quote_value_usd,
          EXCLUDED.quote_value_usd
        ),
        data_quality = CASE
          WHEN wallet_trade_events.execution_price_usd IS NULL
            AND EXCLUDED.execution_price_usd IS NOT NULL
        THEN EXCLUDED.data_quality
        ELSE wallet_trade_events.data_quality
        END,
        raw = wallet_trade_events.raw || EXCLUDED.raw
      WHERE (wallet_trade_events.execution_price_usd IS NULL
             AND EXCLUDED.execution_price_usd IS NOT NULL)
         OR (wallet_trade_events.quote_value_usd IS NULL
             AND EXCLUDED.quote_value_usd IS NOT NULL)
         OR NOT (wallet_trade_events.raw @> EXCLUDED.raw)
      RETURNING chain, wallet_address, strategy_version
      ), queued AS MATERIALIZED (
        SELECT enqueue_wallet_alpha_work(
          chain,
          wallet_address,
          strategy_version,
          $21::smallint,
          $22
        ) AS queued
        FROM changed
      )
      SELECT
        EXISTS(SELECT 1 FROM changed) AS changed,
        (SELECT COUNT(*) FROM queued) AS queued_count`,
      [
        trade.idempotencyKey,
        trade.chain,
        trade.walletAddress,
        trade.tokenAddress,
        trade.quoteTokenAddress ?? null,
        trade.poolAddress ?? null,
        trade.side,
        trade.baseAmount,
        trade.quoteAmount ?? null,
        trade.executionPriceUsd ?? null,
        trade.quoteValueUsd ?? null,
        trade.poolCreatedAt ?? null,
        trade.poolAgeMinutes ?? null,
        trade.dataQuality,
        trade.signature,
        trade.slot,
        trade.provider,
        trade.observedAt,
        trade.strategyVersion,
        trade.raw,
        trade.side === "sell" ? 1 : 0,
        trade.side === "sell" ? "sell-trade" : "buy-trade"
      ]
    );
    return Boolean(result.rows[0]?.changed);
  }

  async enrichWalletTradePrices(observation: PriceObservationEvidence): Promise<number> {
    const result = await this.pool.query(
      `WITH changed AS (
       UPDATE wallet_trade_events
       SET execution_price_usd = $3,
           quote_value_usd = base_amount * $3,
           data_quality = 'price-proxy',
           raw = raw || jsonb_build_object(
             'priceEvidence', jsonb_build_object(
               'quality', 'market-proxy',
               'contextKey', $4::text,
               'provider', $7::text,
               'signature', $8::text,
               'observedAt', $5::text,
               'poolAddress', $2::text,
               'priceUsd', $3::numeric,
               'liquidityUsd', $9::numeric
             )
           )
       WHERE token_address = $1
         AND ($2::text IS NULL OR pool_address = $2)
         AND strategy_version = $6
         AND execution_price_usd IS NULL
         AND observed_at <= $5
         AND observed_at >= $5::timestamptz - INTERVAL '5 minutes'
       RETURNING chain, wallet_address, strategy_version
      ), changed_wallets AS (
        SELECT DISTINCT chain, wallet_address, strategy_version
        FROM changed
      ), queued AS MATERIALIZED (
        SELECT enqueue_wallet_alpha_work(
          chain,
          wallet_address,
          strategy_version,
          0::smallint,
          'price-enrichment'
        ) AS queued
        FROM changed_wallets
      )
      SELECT
        COUNT(*)::int AS changed_count,
        (SELECT COUNT(*) FROM queued) AS queued_count
      FROM changed`,
      [
        observation.tokenAddress,
        observation.poolAddress ?? null,
        observation.priceUsd,
        observation.idempotencyKey,
        observation.observedAt,
        observation.strategyVersion,
        observation.provider,
        observation.signature,
        observation.liquidityUsd
      ]
    );
    return Number(result.rows[0]?.changed_count ?? 0);
  }

  async materializeHistoricalWalletTrades(strategyVersion: string): Promise<number> {
    const result = await this.pool.query(
      `WITH changed AS (
       INSERT INTO wallet_trade_events (
        idempotency_key, chain, wallet_address, token_address, quote_token_address,
        pool_address, side, base_amount, quote_amount, execution_price_usd,
        quote_value_usd, pool_created_at, pool_age_minutes, data_quality,
        signature, slot, provider, observed_at, strategy_version, raw
      )
      SELECT
        encode(digest('wallet-trade:' || c.idempotency_key, 'sha256'), 'hex'),
        c.chain,
        c.trader_address,
        c.token_address,
        c.quote_token_address,
        COALESCE(c.pool_address, matched_pool.pool_address),
        c.side,
        c.base_amount,
        c.quote_amount,
        c.price_usd_estimate,
        c.volume_usd_estimate,
        matched_pool.created_at,
        CASE
          WHEN matched_pool.created_at IS NULL THEN NULL
          ELSE EXTRACT(EPOCH FROM (c.observed_at - matched_pool.created_at)) / 60
        END,
        CASE
          WHEN c.confidence >= 0.8 AND c.volume_usd_estimate > 0
          THEN 'historical-observed'
          ELSE 'historical-estimate'
        END,
        c.signature,
        c.slot,
        c.provider,
        c.observed_at,
        c.strategy_version,
        c.raw || jsonb_build_object(
          'source', 'canonical-historical-market-observation',
          'sourceObservationIdempotencyKey', c.idempotency_key,
          'confidence', c.confidence,
          'priceSource', c.price_source
        )
      FROM canonical_historical_market_observations c
      LEFT JOIN LATERAL (
        SELECT p.pool_address, p.created_at
        FROM pools p
        WHERE p.chain = c.chain
          AND p.base_token_address = c.token_address
          AND (c.pool_address IS NULL OR p.pool_address = c.pool_address)
        ORDER BY
          CASE WHEN p.pool_address = c.pool_address THEN 0 ELSE 1 END,
          p.created_at NULLS LAST
        LIMIT 1
      ) matched_pool ON TRUE
      WHERE c.strategy_version = $1
        AND c.trader_address IS NOT NULL
        AND c.trader_address <> ''
        AND c.base_amount > 0
      ON CONFLICT (idempotency_key) DO UPDATE SET
        execution_price_usd = EXCLUDED.execution_price_usd,
        quote_value_usd = EXCLUDED.quote_value_usd,
        pool_address = COALESCE(wallet_trade_events.pool_address, EXCLUDED.pool_address),
        pool_created_at = COALESCE(wallet_trade_events.pool_created_at, EXCLUDED.pool_created_at),
        pool_age_minutes = COALESCE(wallet_trade_events.pool_age_minutes, EXCLUDED.pool_age_minutes),
        data_quality = EXCLUDED.data_quality,
        raw = wallet_trade_events.raw || EXCLUDED.raw
      WHERE wallet_trade_events.execution_price_usd IS DISTINCT FROM EXCLUDED.execution_price_usd
         OR wallet_trade_events.quote_value_usd IS DISTINCT FROM EXCLUDED.quote_value_usd
         OR (wallet_trade_events.pool_address IS NULL AND EXCLUDED.pool_address IS NOT NULL)
         OR (wallet_trade_events.pool_created_at IS NULL AND EXCLUDED.pool_created_at IS NOT NULL)
         OR (wallet_trade_events.pool_age_minutes IS NULL AND EXCLUDED.pool_age_minutes IS NOT NULL)
         OR wallet_trade_events.data_quality IS DISTINCT FROM EXCLUDED.data_quality
      RETURNING chain, wallet_address, strategy_version
      ), changed_wallets AS (
        SELECT DISTINCT chain, wallet_address, strategy_version
        FROM changed
      ), queued AS MATERIALIZED (
        SELECT enqueue_wallet_alpha_work(
          chain,
          wallet_address,
          strategy_version,
          0::smallint,
          'historical-materialization'
        ) AS queued
        FROM changed_wallets
      )
      SELECT
        COUNT(*)::int AS changed_count,
        (SELECT COUNT(*) FROM queued) AS queued_count
      FROM changed`,
      [strategyVersion]
    );
    return Number(result.rows[0]?.changed_count ?? 0);
  }

  async saveWalletAlphaScore(score: WalletAlphaScoreSnapshot): Promise<void> {
    await this.pool.query(
      `WITH latest AS MATERIALIZED (
        SELECT *
        FROM wallet_alpha_scores
        WHERE chain = $1
          AND wallet_address = $2
          AND strategy_version = $3
        ORDER BY calculated_at DESC
        LIMIT 1
      ), changed AS (
      INSERT INTO wallet_alpha_scores (
        chain, wallet_address, strategy_version, calculated_at, status,
        profitability_score, followability_score, overall_score,
        completed_positions, unique_tokens, active_days, metrics, gates, reasons
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
      WHERE NOT EXISTS (
        SELECT 1
        FROM latest existing
        WHERE ROW(
            existing.status,
            existing.profitability_score,
            existing.followability_score,
            existing.overall_score,
            existing.completed_positions,
            existing.unique_tokens,
            existing.active_days,
            existing.metrics,
            existing.gates,
            existing.reasons
          ) IS NOT DISTINCT FROM ROW($5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
      )
      ON CONFLICT (chain, wallet_address, strategy_version, calculated_at) DO NOTHING
      RETURNING chain, wallet_address, strategy_version, calculated_at
      ), superseded AS (
        INSERT INTO wallet_alpha_score_supersessions (
          chain, wallet_address, strategy_version, calculated_at, superseded_at
        )
        SELECT
          latest.chain,
          latest.wallet_address,
          latest.strategy_version,
          latest.calculated_at,
          changed.calculated_at
        FROM latest
        CROSS JOIN changed
        WHERE latest.calculated_at < changed.calculated_at
        UNION ALL
        SELECT
          changed.chain,
          changed.wallet_address,
          changed.strategy_version,
          changed.calculated_at,
          latest.calculated_at
        FROM latest
        CROSS JOIN changed
        WHERE changed.calculated_at < latest.calculated_at
        ON CONFLICT (chain, wallet_address, strategy_version, calculated_at) DO NOTHING
        RETURNING 1
      )
      SELECT
        (SELECT COUNT(*)::int FROM changed) AS changed_count,
        (SELECT COUNT(*)::int FROM superseded) AS superseded_count`,
      [
        score.chain,
        score.walletAddress,
        score.strategyVersion,
        score.calculatedAt,
        score.status,
        score.profitabilityScore,
        score.followabilityScore,
        score.overallScore,
        score.completedPositions,
        score.uniqueTokens,
        score.activeDays,
        score.metrics,
        score.gates,
        JSON.stringify(score.reasons)
      ]
    );
  }

  async replaceWalletPositionLedger(
    snapshot: WalletPositionLedgerSnapshot
  ): Promise<WalletPositionLedgerWriteResult> {
    assertWalletPositionLedgerSnapshot(snapshot);
    const walletScope = snapshot.walletAddresses ?? null;
    const episodeRows = snapshot.episodes.map((episode) => ({
      id: episode.id,
      chain: episode.chain,
      wallet_address: episode.walletAddress,
      token_address: episode.tokenAddress,
      strategy_version: episode.strategyVersion,
      episode_index: episode.episodeIndex,
      status: episode.status,
      opened_at: episode.openedAt,
      closed_at: episode.closedAt ?? null,
      cost_basis_usd: episode.costBasisUsd,
      proceeds_usd: episode.proceedsUsd,
      realized_pnl_usd: episode.realizedPnlUsd,
      return_pct: episode.returnPct ?? null,
      remaining_raw_amount: episode.remainingRawAmount,
      token_decimals: episode.tokenDecimals,
      realized_lot_count: episode.realizedLotCount,
      high_quality_price_coverage: episode.highQualityPriceCoverage,
      terminal_reason: episode.terminalReason ?? null,
      metadata: episode.metadata
    }));
    const lotRows = snapshot.lots.map((lot) => ({
      id: lot.id,
      episode_id: lot.episodeId,
      source_event_idempotency_key: lot.sourceEventIdempotencyKey,
      lot_sequence: lot.lotSequence,
      raw_amount: lot.rawAmount,
      remaining_raw_amount: lot.remainingRawAmount,
      token_decimals: lot.tokenDecimals,
      quote_cost_usd: lot.quoteCostUsd,
      fees_usd: lot.feesUsd,
      slippage_usd: lot.slippageUsd,
      opened_at: lot.openedAt,
      closed_at: lot.closedAt ?? null,
      status: lot.status,
      metadata: lot.metadata
    }));

    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        snapshot.chain,
        snapshot.strategyVersion
      ]);
      if (episodeRows.length > 0) {
        await client.query(
          `INSERT INTO wallet_position_episodes (
            id, chain, wallet_address, token_address, strategy_version, episode_index,
            status, opened_at, closed_at, cost_basis_usd, proceeds_usd, realized_pnl_usd,
            return_pct, remaining_raw_amount, token_decimals, realized_lot_count,
            high_quality_price_coverage, terminal_reason, metadata
          )
          SELECT
            input.id, input.chain, input.wallet_address, input.token_address,
            input.strategy_version, input.episode_index, input.status, input.opened_at,
            input.closed_at, input.cost_basis_usd, input.proceeds_usd,
            input.realized_pnl_usd, input.return_pct, input.remaining_raw_amount,
            input.token_decimals, input.realized_lot_count,
            input.high_quality_price_coverage, input.terminal_reason, input.metadata
          FROM jsonb_to_recordset($1::jsonb) AS input(
            id text, chain text, wallet_address text, token_address text,
            strategy_version text, episode_index integer, status text,
            opened_at timestamptz, closed_at timestamptz, cost_basis_usd numeric,
            proceeds_usd numeric, realized_pnl_usd numeric, return_pct numeric,
            remaining_raw_amount numeric, token_decimals smallint,
            realized_lot_count integer, high_quality_price_coverage numeric,
            terminal_reason text, metadata jsonb
          )
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            closed_at = EXCLUDED.closed_at,
            cost_basis_usd = EXCLUDED.cost_basis_usd,
            proceeds_usd = EXCLUDED.proceeds_usd,
            realized_pnl_usd = EXCLUDED.realized_pnl_usd,
            return_pct = EXCLUDED.return_pct,
            remaining_raw_amount = EXCLUDED.remaining_raw_amount,
            token_decimals = EXCLUDED.token_decimals,
            realized_lot_count = EXCLUDED.realized_lot_count,
            high_quality_price_coverage = EXCLUDED.high_quality_price_coverage,
            terminal_reason = EXCLUDED.terminal_reason,
            metadata = EXCLUDED.metadata
          WHERE ROW(
            wallet_position_episodes.status,
            wallet_position_episodes.closed_at,
            wallet_position_episodes.cost_basis_usd,
            wallet_position_episodes.proceeds_usd,
            wallet_position_episodes.realized_pnl_usd,
            wallet_position_episodes.return_pct,
            wallet_position_episodes.remaining_raw_amount,
            wallet_position_episodes.token_decimals,
            wallet_position_episodes.realized_lot_count,
            wallet_position_episodes.high_quality_price_coverage,
            wallet_position_episodes.terminal_reason,
            wallet_position_episodes.metadata
          ) IS DISTINCT FROM ROW(
            EXCLUDED.status,
            EXCLUDED.closed_at,
            EXCLUDED.cost_basis_usd,
            EXCLUDED.proceeds_usd,
            EXCLUDED.realized_pnl_usd,
            EXCLUDED.return_pct,
            EXCLUDED.remaining_raw_amount,
            EXCLUDED.token_decimals,
            EXCLUDED.realized_lot_count,
            EXCLUDED.high_quality_price_coverage,
            EXCLUDED.terminal_reason,
            EXCLUDED.metadata
          )`,
          [JSON.stringify(episodeRows)]
        );
      }

      const incomingLotIds = snapshot.lots.map((lot) => lot.id);
      await client.query(
        `DELETE FROM wallet_position_lots AS lot
         USING wallet_position_episodes AS episode
         WHERE lot.episode_id = episode.id
           AND episode.chain = $1
           AND episode.strategy_version = $2
           AND ($4::text[] IS NULL OR episode.wallet_address = ANY($4::text[]))
           AND NOT (lot.id = ANY($3::text[]))`,
        [snapshot.chain, snapshot.strategyVersion, incomingLotIds, walletScope]
      );

      const incomingEpisodeIds = snapshot.episodes.map((episode) => episode.id);
      await client.query(
        `DELETE FROM wallet_position_episodes
         WHERE chain = $1 AND strategy_version = $2
           AND ($4::text[] IS NULL OR wallet_address = ANY($4::text[]))
           AND NOT (id = ANY($3::text[]))`,
        [snapshot.chain, snapshot.strategyVersion, incomingEpisodeIds, walletScope]
      );

      if (lotRows.length > 0) {
        await client.query(
          `INSERT INTO wallet_position_lots (
            id, episode_id, source_event_idempotency_key, lot_sequence, raw_amount,
            remaining_raw_amount, token_decimals, quote_cost_usd, fees_usd,
            slippage_usd, opened_at, closed_at, status, metadata
          )
          SELECT
            input.id, input.episode_id, input.source_event_idempotency_key,
            input.lot_sequence, input.raw_amount, input.remaining_raw_amount,
            input.token_decimals, input.quote_cost_usd, input.fees_usd,
            input.slippage_usd, input.opened_at, input.closed_at, input.status,
            input.metadata
          FROM jsonb_to_recordset($1::jsonb) AS input(
            id text, episode_id text, source_event_idempotency_key text,
            lot_sequence integer, raw_amount numeric, remaining_raw_amount numeric,
            token_decimals smallint, quote_cost_usd numeric, fees_usd numeric,
            slippage_usd numeric, opened_at timestamptz, closed_at timestamptz,
            status text, metadata jsonb
          )
          ON CONFLICT (id) DO UPDATE SET
            remaining_raw_amount = EXCLUDED.remaining_raw_amount,
            quote_cost_usd = EXCLUDED.quote_cost_usd,
            fees_usd = EXCLUDED.fees_usd,
            slippage_usd = EXCLUDED.slippage_usd,
            closed_at = EXCLUDED.closed_at,
            status = EXCLUDED.status,
            metadata = EXCLUDED.metadata
          WHERE ROW(
            wallet_position_lots.remaining_raw_amount,
            wallet_position_lots.quote_cost_usd,
            wallet_position_lots.fees_usd,
            wallet_position_lots.slippage_usd,
            wallet_position_lots.closed_at,
            wallet_position_lots.status,
            wallet_position_lots.metadata
          ) IS DISTINCT FROM ROW(
            EXCLUDED.remaining_raw_amount,
            EXCLUDED.quote_cost_usd,
            EXCLUDED.fees_usd,
            EXCLUDED.slippage_usd,
            EXCLUDED.closed_at,
            EXCLUDED.status,
            EXCLUDED.metadata
          )`,
          [JSON.stringify(lotRows)]
        );
      }
      return { episodeCount: episodeRows.length, lotCount: lotRows.length };
    });
  }

  async claimWalletAlphaWork(options: WalletAlphaWorkClaimOptions): Promise<WalletAlphaWorkItem[]> {
    const limit = clampLimit(options.limit, 100, 1_000);
    const leaseSeconds = clampLimit(options.leaseSeconds, 300, 3_600);
    const minimumPriority = options.minimumPriority ?? 0;
    const maximumPriority = options.maximumPriority ?? 2;
    assertWalletAlphaPriorityRange(minimumPriority, maximumPriority);
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT chain, wallet_address, strategy_version
         FROM wallet_alpha_work_queue
         WHERE strategy_version = $1
           AND revision > completed_revision
           AND not_before <= NOW()
           AND (lock_expires_at IS NULL OR lock_expires_at <= NOW())
           AND priority BETWEEN $5 AND $6
         -- Signal-relevant work preempts historical catch-up. Within a lane,
         -- retry readiness and age preserve deterministic fairness.
         ORDER BY priority DESC, not_before, updated_at, wallet_address
         LIMIT $4
         FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE wallet_alpha_work_queue AS work
         SET locked_by = $2,
             locked_at = NOW(),
             lock_expires_at = NOW() + make_interval(secs => $3::integer),
             attempt_count = work.attempt_count + 1
         FROM candidates
         WHERE work.chain = candidates.chain
           AND work.wallet_address = candidates.wallet_address
           AND work.strategy_version = candidates.strategy_version
         RETURNING work.*
       )
       SELECT * FROM claimed ORDER BY priority DESC, not_before, updated_at, wallet_address`,
      [
        options.strategyVersion,
        options.workerId,
        leaseSeconds,
        limit,
        minimumPriority,
        maximumPriority
      ]
    );
    return result.rows.map((row) => ({
      chain: row.chain as ChainId,
      walletAddress: String(row.wallet_address),
      strategyVersion: String(row.strategy_version),
      revision: Number(row.revision),
      attemptCount: Number(row.attempt_count),
      lockedBy: String(row.locked_by),
      lockExpiresAt: new Date(row.lock_expires_at).toISOString(),
      priority: Number(row.priority) as WalletAlphaWorkPriority,
      ...(row.priority_reason ? { priorityReason: String(row.priority_reason) } : {}),
      pendingSince: new Date(row.pending_since ?? row.updated_at).toISOString()
    }));
  }

  async listWalletAlphaWorkCandidates(
    strategyVersion: string,
    limit = 100,
    priorities: Pick<WalletAlphaWorkClaimOptions, "minimumPriority" | "maximumPriority"> = {}
  ): Promise<WalletAlphaWorkCandidate[]> {
    const boundedLimit = clampLimit(limit, 100, 100);
    const minimumPriority = priorities.minimumPriority ?? 0;
    const maximumPriority = priorities.maximumPriority ?? 2;
    assertWalletAlphaPriorityRange(minimumPriority, maximumPriority);
    const result = await this.pool.query(
      `SELECT chain, wallet_address, strategy_version, revision, priority, pending_since, updated_at
       FROM wallet_alpha_work_queue
       WHERE strategy_version = $1
         AND revision > completed_revision
         AND not_before <= NOW()
         AND (lock_expires_at IS NULL OR lock_expires_at <= NOW())
         AND priority BETWEEN $3 AND $4
       -- Keep prefetch and claim order identical to the priority index.
       ORDER BY priority DESC, not_before, updated_at, wallet_address
       LIMIT $2`,
      [strategyVersion, boundedLimit, minimumPriority, maximumPriority]
    );
    return result.rows.map((row) => ({
      chain: row.chain as ChainId,
      walletAddress: String(row.wallet_address),
      strategyVersion: String(row.strategy_version),
      revision: Number(row.revision),
      priority: Number(row.priority) as WalletAlphaWorkPriority,
      pendingSince: new Date(row.pending_since ?? row.updated_at).toISOString()
    }));
  }

  async probeWalletAlphaAdmission(
    candidates: WalletAlphaWorkCandidate[],
    minEntryObservedAt: string,
    minimumTradeEvents: number,
    minimumEntries: number
  ): Promise<WalletAlphaAdmissionProbe[]> {
    if (candidates.length === 0) return [];
    if (candidates.length > 100) {
      throw new Error("Wallet-alpha admission probe exceeds the 100-wallet ceiling.");
    }
    const tradeThreshold = clampLimit(minimumTradeEvents, 1, 100);
    const entryThreshold = clampLimit(minimumEntries, 1, 100);
    const uniqueKeys = new Set<string>();
    const records = candidates.map((candidate, ordinal) => {
      const key = walletAlphaWorkRevisionKey(candidate);
      if (uniqueKeys.has(key)) {
        throw new Error(`Duplicate wallet-alpha admission candidate: ${key}`);
      }
      uniqueKeys.add(key);
      return {
        ordinal,
        chain: candidate.chain,
        wallet_address: candidate.walletAddress,
        strategy_version: candidate.strategyVersion,
        revision: candidate.revision,
        priority: candidate.priority,
        pending_since: candidate.pendingSince
      };
    });

    return this.withTransaction(async (client) => {
      // This prefetch is an optimization only. It is separate from the ordered
      // claim statement, hard-bounded to 100 wallets and cannot hold a queue lease.
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await client.query(
        `WITH input AS (
           SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS candidate(
             ordinal integer,
             chain text,
             wallet_address text,
             strategy_version text,
             revision bigint,
             priority smallint,
             pending_since timestamptz
           )
         )
         SELECT
           input.chain,
           input.wallet_address,
           input.strategy_version,
           input.revision,
           input.priority,
           input.pending_since,
           bounded_trades.trade_event_count,
           bounded_entries.entry_count
         FROM input
         CROSS JOIN LATERAL (
           SELECT COUNT(*)::integer AS trade_event_count
           FROM (
             SELECT 1
             FROM wallet_trade_events trade
             WHERE trade.strategy_version = input.strategy_version
               AND trade.wallet_address = input.wallet_address
             LIMIT $2
           ) rows
         ) bounded_trades
         CROSS JOIN LATERAL (
           SELECT COUNT(*)::integer AS entry_count
           FROM (
             SELECT 1
             FROM wallet_entry_signals entry
             WHERE entry.strategy_version = input.strategy_version
               AND entry.wallet_address = input.wallet_address
               AND entry.observed_at >= $4
             LIMIT $3
           ) rows
         ) bounded_entries
         ORDER BY input.ordinal`,
        [JSON.stringify(records), tradeThreshold, entryThreshold, minEntryObservedAt]
      );
      return result.rows.map((row) => ({
        chain: row.chain as ChainId,
        walletAddress: String(row.wallet_address),
        strategyVersion: String(row.strategy_version),
        revision: Number(row.revision),
        priority: Number(row.priority) as WalletAlphaWorkPriority,
        pendingSince: new Date(row.pending_since).toISOString(),
        tradeEventCount: Number(row.trade_event_count),
        entryCount: Number(row.entry_count)
      }));
    });
  }

  async completeWalletAlphaWork(item: WalletAlphaWorkItem): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE wallet_alpha_work_queue
       SET completed_revision = GREATEST(completed_revision, $4),
           priority = CASE WHEN revision <= $4 THEN 0 ELSE priority END,
           priority_reason = CASE WHEN revision <= $4 THEN NULL ELSE priority_reason END,
           pending_since = CASE WHEN revision <= $4 THEN NULL ELSE pending_since END,
           locked_by = NULL,
           locked_at = NULL,
           lock_expires_at = NULL,
           attempt_count = 0,
           last_error = NULL,
           quarantine_reason = NULL
       WHERE chain = $1
         AND wallet_address = $2
         AND strategy_version = $3
         AND locked_by = $5`,
      [item.chain, item.walletAddress, item.strategyVersion, item.revision, item.lockedBy]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async failWalletAlphaWork(
    item: WalletAlphaWorkItem,
    error: string,
    retrySeconds = 300,
    failureClass: "transient" | "evidence_limit" = "transient"
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE wallet_alpha_work_queue
       SET locked_by = NULL,
           locked_at = NULL,
           lock_expires_at = NULL,
           not_before = NOW() + make_interval(secs => $4::integer),
           last_error = LEFT($5, 4_000),
           quarantine_reason = $7
       WHERE chain = $1
         AND wallet_address = $2
         AND strategy_version = $3
         AND locked_by = $6`,
      [
        item.chain,
        item.walletAddress,
        item.strategyVersion,
        clampLimit(retrySeconds, 300, 86_400),
        error,
        item.lockedBy,
        failureClass === "evidence_limit" ? "evidence_limit" : null
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async probeWalletAlphaEvidenceBounds(
    item: WalletAlphaWorkItem,
    minObservedAt: string,
    maximumTradeEvents: number,
    maximumEntries: number,
    maximumOutcomes: number
  ): Promise<{
    tradeEventsExceeded: boolean;
    entriesExceeded: boolean;
    outcomesExceeded: boolean;
  }> {
    const tradeLimit = clampLimit(maximumTradeEvents, 10_000, 100_000);
    const entryLimit = clampLimit(maximumEntries, 2_000, 50_000);
    const outcomeLimit = clampLimit(maximumOutcomes, 4_000, 100_000);
    return this.withTransaction(async (client) => {
      // Keep each indexed ceiling probe independently bounded. A single
      // statement used to share one five-second budget across all three
      // relations, so a valid wallet could be retried forever when the sum of
      // otherwise healthy probes crossed that boundary under production I/O.
      await client.query("SET LOCAL statement_timeout = '5s'");
      const common = [item.chain, item.walletAddress, item.strategyVersion];
      const trades = await boundedWalletAlphaProbe(
        client,
        "trade-events",
        `SELECT EXISTS (
           SELECT 1
           FROM wallet_trade_events trade
           WHERE trade.chain = $1
             AND trade.wallet_address = $2
             AND trade.strategy_version = $3
           OFFSET $4 LIMIT 1
         ) AS exceeded`,
        [...common, tradeLimit]
      );
      const entries = await boundedWalletAlphaProbe(
        client,
        "entries",
        `SELECT EXISTS (
           SELECT 1
           FROM wallet_entry_signals entry
           WHERE entry.chain = $1
             AND entry.wallet_address = $2
             AND entry.strategy_version = $3
             AND entry.observed_at >= $4
           OFFSET $5 LIMIT 1
         ) AS exceeded`,
        [...common, minObservedAt, entryLimit]
      );
      const outcomes = await boundedWalletAlphaProbe(
        client,
        "outcomes",
        `SELECT EXISTS (
           SELECT 1
           FROM wallet_signal_outcomes outcome
           JOIN wallet_entry_signals entry
             ON entry.idempotency_key = outcome.entry_idempotency_key
           WHERE entry.chain = $1
             AND entry.wallet_address = $2
             AND entry.strategy_version = $3
             AND outcome.strategy_version = $3
             AND outcome.observed_at >= $4
           OFFSET $5 LIMIT 1
         ) AS exceeded`,
        [...common, minObservedAt, outcomeLimit]
      );
      return {
        tradeEventsExceeded: trades,
        entriesExceeded: entries,
        outcomesExceeded: outcomes
      };
    });
  }

  async getWalletAlphaWorkSummary(strategyVersion: string): Promise<WalletAlphaWorkSummary> {
    const result = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE revision > completed_revision)::int AS pending,
         COUNT(*) FILTER (
           WHERE revision > completed_revision AND lock_expires_at > NOW()
         )::int AS processing,
         COUNT(*) FILTER (
           WHERE revision > completed_revision AND last_error IS NOT NULL
         )::int AS failed,
         COUNT(*) FILTER (
           WHERE revision > completed_revision AND priority = 0
         )::int AS background_pending,
         COUNT(*) FILTER (
           WHERE revision > completed_revision AND priority = 1
         )::int AS elevated_pending,
         COUNT(*) FILTER (
           WHERE revision > completed_revision AND priority = 2
         )::int AS signal_pending,
         MIN(pending_since) FILTER (
           WHERE revision > completed_revision
         ) AS oldest_pending_at,
         MIN(pending_since) FILTER (
           WHERE revision > completed_revision AND priority = 2
         ) AS oldest_signal_pending_at
       FROM wallet_alpha_work_queue
       WHERE strategy_version = $1`,
      [strategyVersion]
    );
    return {
      pending: Number(result.rows[0]?.pending ?? 0),
      processing: Number(result.rows[0]?.processing ?? 0),
      failed: Number(result.rows[0]?.failed ?? 0),
      backgroundPending: Number(result.rows[0]?.background_pending ?? 0),
      elevatedPending: Number(result.rows[0]?.elevated_pending ?? 0),
      signalPending: Number(result.rows[0]?.signal_pending ?? 0),
      ...(result.rows[0]?.oldest_pending_at
        ? { oldestPendingAt: new Date(result.rows[0].oldest_pending_at).toISOString() }
        : {}),
      ...(result.rows[0]?.oldest_signal_pending_at
        ? { oldestSignalPendingAt: new Date(result.rows[0].oldest_signal_pending_at).toISOString() }
        : {})
    };
  }

  async getWalletAlphaStatusCounts(strategyVersion: string): Promise<WalletAlphaStatusCounts> {
    const result = await this.pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (strategy_version, chain, wallet_address) status
         FROM wallet_alpha_scores
         WHERE strategy_version = $1
         ORDER BY strategy_version, chain, wallet_address, calculated_at DESC
       )
       SELECT
         COUNT(*) FILTER (WHERE status = 'insufficient')::int AS insufficient,
         COUNT(*) FILTER (WHERE status = 'observed')::int AS observed,
         COUNT(*) FILTER (WHERE status = 'watch')::int AS watch,
         COUNT(*) FILTER (WHERE status = 'candidate')::int AS candidate,
         COUNT(*) FILTER (WHERE status = 'validated-paper')::int AS validated_paper,
         COUNT(*) FILTER (WHERE status = 'excluded')::int AS excluded
       FROM latest`,
      [strategyVersion]
    );
    const row = result.rows[0] ?? {};
    return {
      insufficient: Number(row.insufficient ?? 0),
      observed: Number(row.observed ?? 0),
      watch: Number(row.watch ?? 0),
      candidate: Number(row.candidate ?? 0),
      "validated-paper": Number(row.validated_paper ?? 0),
      excluded: Number(row.excluded ?? 0)
    };
  }

  async getWalletAlphaCoverageSummary(
    strategyVersion: string,
    minObservedAt: string
  ): Promise<WalletAlphaCoverageSummary> {
    const result = await this.pool.query(
      `WITH trade_summary AS (
         SELECT
           COUNT(*)::int AS trade_events,
           COUNT(*) FILTER (WHERE side = 'buy')::int AS buy_events,
           COUNT(*) FILTER (WHERE side = 'sell')::int AS sell_events,
           COUNT(*) FILTER (
             WHERE execution_price_usd > 0 OR quote_value_usd > 0
           )::int AS priced_events,
           COUNT(*) FILTER (
             WHERE (execution_price_usd > 0 OR quote_value_usd > 0)
               AND data_quality IN (
                 'observed-execution', 'oracle-converted', 'historical-observed'
               )
           )::int AS high_quality_priced_events
         FROM wallet_trade_events
         WHERE strategy_version = $1 AND observed_at >= $2
       ), entry_summary AS (
         SELECT
           COUNT(*) FILTER (
             WHERE NULLIF(BTRIM(source_swap_idempotency_key), '') IS NOT NULL
           )::int AS source_linked_follower_entries,
           COUNT(*) FILTER (
             WHERE NULLIF(BTRIM(source_swap_idempotency_key), '') IS NOT NULL
               AND cohort <> 'excluded-uncontrolled-flow'
           )::int AS eligible_source_linked_follower_entries,
           COUNT(*) FILTER (
             WHERE NULLIF(BTRIM(source_swap_idempotency_key), '') IS NOT NULL
               AND cohort = 'excluded-uncontrolled-flow'
           )::int AS excluded_uncontrolled_flow_entries,
           COUNT(*) FILTER (
             WHERE NULLIF(BTRIM(source_swap_idempotency_key), '') IS NOT NULL
               AND cohort <> 'excluded-uncontrolled-flow'
               AND flow_evidence @> '{"tokenRiskKnown":true,"tokenRiskPassed":true}'::jsonb
           )::int AS risk_passed_entries,
           COUNT(*) FILTER (
             WHERE NULLIF(BTRIM(source_swap_idempotency_key), '') IS NOT NULL
               AND cohort <> 'excluded-uncontrolled-flow'
               AND NOT (flow_evidence @> '{"tokenRiskKnown":true}'::jsonb)
           )::int AS unknown_risk_blocked_entries,
           COUNT(*) FILTER (
             WHERE NULLIF(BTRIM(source_swap_idempotency_key), '') IS NOT NULL
               AND cohort <> 'excluded-uncontrolled-flow'
               AND flow_evidence @> '{"tokenRiskKnown":true}'::jsonb
               AND NOT (flow_evidence @> '{"tokenRiskPassed":true}'::jsonb)
           )::int AS failed_risk_blocked_entries
         FROM wallet_entry_signals
         WHERE strategy_version = $1 AND observed_at >= $2
       ), outcome_summary AS (
         SELECT
           COUNT(*) FILTER (
             WHERE outcome.status = 'mature'
               AND outcome.exit_strategy = 'fixed-horizon'
               AND NULLIF(BTRIM(entry.source_swap_idempotency_key), '') IS NOT NULL
           )::int AS mature_follower_outcomes,
           COUNT(*) FILTER (
             WHERE outcome.status = 'mature'
               AND outcome.exit_strategy = 'fixed-horizon'
               AND NULLIF(BTRIM(entry.source_swap_idempotency_key), '') IS NOT NULL
               AND entry.cohort <> 'excluded-uncontrolled-flow'
           )::int AS eligible_mature_follower_outcomes
         FROM wallet_signal_outcomes outcome
         JOIN wallet_entry_signals entry
           ON entry.idempotency_key = outcome.entry_idempotency_key
         WHERE outcome.strategy_version = $1 AND outcome.observed_at >= $2
       ), score_summary AS (
         SELECT
           COALESCE(SUM(completed_positions), 0)::int AS completed_positions,
           COALESCE(SUM(COALESCE((metrics->>'openInventoryCount')::int, 0)), 0)::int
             AS open_inventories
         FROM (
           SELECT DISTINCT ON (strategy_version, chain, wallet_address)
             completed_positions, metrics
           FROM wallet_alpha_scores
           WHERE strategy_version = $1
           ORDER BY strategy_version, chain, wallet_address, calculated_at DESC
         ) latest_scores
       ), wallet_summary AS (
         SELECT COUNT(*)::int AS wallets_seen
         FROM (
           SELECT wallet_address
           FROM wallet_trade_events
           WHERE strategy_version = $1 AND observed_at >= $2
           UNION
           SELECT wallet_address
           FROM wallet_entry_signals
           WHERE strategy_version = $1 AND observed_at >= $2
         ) wallets
       )
       SELECT
         trade_summary.*,
         wallet_summary.wallets_seen,
         score_summary.*,
         entry_summary.*,
         outcome_summary.*
       FROM trade_summary
       CROSS JOIN wallet_summary
       CROSS JOIN score_summary
       CROSS JOIN entry_summary
       CROSS JOIN outcome_summary`,
      [strategyVersion, minObservedAt]
    );
    const row = result.rows[0] ?? {};
    return {
      tradeEvents: Number(row.trade_events ?? 0),
      buyEvents: Number(row.buy_events ?? 0),
      sellEvents: Number(row.sell_events ?? 0),
      pricedEvents: Number(row.priced_events ?? 0),
      highQualityPricedEvents: Number(row.high_quality_priced_events ?? 0),
      walletsSeen: Number(row.wallets_seen ?? 0),
      completedPositions: Number(row.completed_positions ?? 0),
      openInventories: Number(row.open_inventories ?? 0),
      sourceLinkedFollowerEntries: Number(row.source_linked_follower_entries ?? 0),
      eligibleSourceLinkedFollowerEntries: Number(row.eligible_source_linked_follower_entries ?? 0),
      excludedUncontrolledFlowEntries: Number(row.excluded_uncontrolled_flow_entries ?? 0),
      matureFollowerOutcomes: Number(row.mature_follower_outcomes ?? 0),
      eligibleMatureFollowerOutcomes: Number(row.eligible_mature_follower_outcomes ?? 0),
      riskPassedEntries: Number(row.risk_passed_entries ?? 0),
      unknownRiskBlockedEntries: Number(row.unknown_risk_blocked_entries ?? 0),
      failedRiskBlockedEntries: Number(row.failed_risk_blocked_entries ?? 0)
    };
  }

  async saveWalletAlphaSignal(signal: WalletAlphaSignalEvidence): Promise<boolean> {
    const result = await this.pool.query(
      `WITH inserted AS (
        INSERT INTO wallet_alpha_signals (
          id, chain, token_address, pool_address, strategy_version, detected_at,
          observed_price_usd, observed_liquidity_usd, confidence, status,
          wallet_addresses, evidence
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (strategy_version, token_address) DO NOTHING
        RETURNING id
      ), enqueued AS (
        INSERT INTO signal_outbox (id, signal_id, destination, payload)
        SELECT inserted.id || ':' || destination, inserted.id, destination, $13::jsonb
        FROM inserted
        CROSS JOIN unnest(ARRAY['paper', 'alert']::text[]) AS destination
        ON CONFLICT (signal_id, destination) DO NOTHING
        RETURNING id
      )
      SELECT COUNT(*)::integer AS inserted FROM inserted`,
      [
        signal.id,
        signal.chain,
        signal.tokenAddress,
        signal.poolAddress ?? null,
        signal.strategyVersion,
        signal.detectedAt,
        signal.observedPriceUsd,
        signal.observedLiquidityUsd,
        signal.confidence,
        signal.status,
        JSON.stringify(signal.walletAddresses),
        signal.evidence,
        JSON.stringify(signal)
      ]
    );
    return Number(result.rows[0]?.inserted ?? 0) > 0;
  }

  async saveHistoricalMarketObservation(
    observation: HistoricalMarketObservation
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO historical_market_observations (
        idempotency_key, chain, token_address, quote_token_address, pool_address,
        trader_address, side, base_amount, quote_amount, price_quote,
        price_usd_estimate, volume_usd_estimate, price_source, confidence,
        signature, slot, provider, observed_at, strategy_version, raw
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
      )
      ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        observation.idempotencyKey,
        observation.chain,
        observation.tokenAddress,
        observation.quoteTokenAddress,
        observation.poolAddress ?? null,
        observation.traderAddress ?? null,
        observation.side,
        observation.baseAmount,
        observation.quoteAmount,
        observation.priceQuote,
        observation.priceUsdEstimate,
        observation.volumeUsdEstimate,
        observation.priceSource,
        observation.confidence,
        observation.signature,
        observation.slot,
        observation.provider,
        observation.observedAt,
        observation.strategyVersion,
        observation.raw
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getHistoricalBackfillWindow(
    runId: string,
    stage: HistoricalBackfillWindow["stage"],
    address: string,
    windowStartUnix: number,
    windowEndUnix: number
  ): Promise<HistoricalBackfillWindow | undefined> {
    const result = await this.pool.query(
      `SELECT *
       FROM historical_backfill_windows
       WHERE run_id = $1
         AND stage = $2
         AND address = $3
         AND window_start_unix = $4
         AND window_end_unix = $5`,
      [runId, stage, address, windowStartUnix, windowEndUnix]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? rowToHistoricalBackfillWindow(row) : undefined;
  }

  async upsertHistoricalBackfillWindow(window: HistoricalBackfillWindow): Promise<void> {
    await this.pool.query(
      `INSERT INTO historical_backfill_windows (
        run_id, stage, address, window_start_unix, window_end_unix, status,
        pages_fetched, transactions_fetched, last_signature, last_slot,
        provider, strategy_version, updated_at, raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (run_id, stage, address, window_start_unix, window_end_unix)
      DO UPDATE SET
        status = EXCLUDED.status,
        pages_fetched = EXCLUDED.pages_fetched,
        transactions_fetched = EXCLUDED.transactions_fetched,
        last_signature = EXCLUDED.last_signature,
        last_slot = EXCLUDED.last_slot,
        provider = EXCLUDED.provider,
        strategy_version = EXCLUDED.strategy_version,
        updated_at = EXCLUDED.updated_at,
        raw = historical_backfill_windows.raw || EXCLUDED.raw`,
      [
        window.runId,
        window.stage,
        window.address,
        window.windowStartUnix,
        window.windowEndUnix,
        window.status,
        window.pagesFetched,
        window.transactionsFetched,
        window.lastSignature ?? null,
        window.lastSlot ?? null,
        window.provider,
        window.strategyVersion,
        window.updatedAt,
        window.raw
      ]
    );
  }

  async getHistoricalBackfillWindowSummary(runId: string): Promise<{
    completed: number;
    saturated: number;
    running: number;
    error: number;
  }> {
    const result = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
         COUNT(*) FILTER (WHERE status = 'saturated')::int AS saturated,
         COUNT(*) FILTER (WHERE status = 'running')::int AS running,
         COUNT(*) FILTER (WHERE status = 'error')::int AS error
       FROM historical_backfill_windows
       WHERE run_id = $1`,
      [runId]
    );
    const row = result.rows[0] as Record<string, unknown>;
    return {
      completed: Number(row.completed ?? 0),
      saturated: Number(row.saturated ?? 0),
      running: Number(row.running ?? 0),
      error: Number(row.error ?? 0)
    };
  }

  async getHistoricalBackfillRequestCount(runId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(pages_fetched), 0)::int AS requests
       FROM historical_backfill_windows
       WHERE run_id = $1`,
      [runId]
    );
    return Number(result.rows[0]?.requests ?? 0);
  }

  async materializeHistoricalMarketBuckets(
    strategyVersion: string,
    intervalMinutes = 5
  ): Promise<number> {
    const result = await this.pool.query(
      `WITH canonical AS (
        SELECT
          chain,
          token_address,
          quote_token_address,
          MAX(pool_address) AS pool_address,
          MAX(trader_address) AS trader_address,
          side,
          SUM(base_amount) AS base_amount,
          MAX(quote_amount) AS quote_amount,
          MAX(quote_amount) / NULLIF(SUM(base_amount), 0) AS price_quote,
          MAX(volume_usd_estimate) AS volume_usd_estimate,
          MAX(confidence) AS confidence,
          MIN(slot) AS slot,
          MIN(observed_at) AS observed_at,
          MAX(provider) AS provider,
          MIN(idempotency_key) AS idempotency_key
        FROM historical_market_observations
        WHERE strategy_version = $1
        GROUP BY
          chain,
          token_address,
          quote_token_address,
          signature,
          side
      ),
      aggregated AS (
        SELECT
          COALESCE(
            pool_address,
            'unresolved:' || token_address || ':' || quote_token_address
          ) AS pair_key,
          chain,
          token_address,
          quote_token_address,
          pool_address,
          to_timestamp(
            floor(extract(epoch FROM observed_at) / ($2::integer * 60))
            * ($2::integer * 60)
          ) AS bucket_start,
          (array_agg(price_quote ORDER BY observed_at, slot, idempotency_key))[1]
            AS open_price_quote,
          MAX(price_quote) AS high_price_quote,
          MIN(price_quote) AS low_price_quote,
          (array_agg(price_quote ORDER BY observed_at DESC, slot DESC, idempotency_key DESC))[1]
            AS close_price_quote,
          SUM(quote_amount) AS volume_quote,
          SUM(volume_usd_estimate) AS volume_usd_estimate,
          COUNT(*) FILTER (WHERE side = 'buy')::integer AS buy_count,
          COUNT(*) FILTER (WHERE side = 'sell')::integer AS sell_count,
          COUNT(DISTINCT trader_address)::integer AS unique_traders,
          COUNT(DISTINCT trader_address) FILTER (WHERE side = 'buy')::integer
            AS unique_buyers,
          COUNT(DISTINCT trader_address) FILTER (WHERE side = 'sell')::integer
            AS unique_sellers,
          COUNT(*)::integer AS observation_count,
          AVG(confidence) AS average_confidence,
          MIN(slot) AS first_slot,
          MAX(slot) AS last_slot,
          MAX(provider) AS provider
        FROM canonical
        GROUP BY
          chain,
          token_address,
          quote_token_address,
          pool_address,
          to_timestamp(
            floor(extract(epoch FROM observed_at) / ($2::integer * 60))
            * ($2::integer * 60)
          )
      )
      INSERT INTO historical_market_buckets (
        pair_key, chain, token_address, quote_token_address, pool_address,
        interval_minutes, bucket_start, open_price_quote, high_price_quote,
        low_price_quote, close_price_quote, volume_quote, volume_usd_estimate,
        buy_count, sell_count, unique_traders, observation_count,
        unique_buyers, unique_sellers, average_confidence,
        first_slot, last_slot, provider, strategy_version
      )
      SELECT
        pair_key, chain, token_address, quote_token_address, pool_address,
        $2, bucket_start, open_price_quote, high_price_quote,
        low_price_quote, close_price_quote, volume_quote, volume_usd_estimate,
        buy_count, sell_count, unique_traders, observation_count,
        unique_buyers, unique_sellers, average_confidence,
        first_slot, last_slot, provider, $1
      FROM aggregated
      ON CONFLICT (pair_key, interval_minutes, bucket_start, strategy_version)
      DO UPDATE SET
        open_price_quote = EXCLUDED.open_price_quote,
        high_price_quote = EXCLUDED.high_price_quote,
        low_price_quote = EXCLUDED.low_price_quote,
        close_price_quote = EXCLUDED.close_price_quote,
        volume_quote = EXCLUDED.volume_quote,
        volume_usd_estimate = EXCLUDED.volume_usd_estimate,
        buy_count = EXCLUDED.buy_count,
        sell_count = EXCLUDED.sell_count,
        unique_traders = EXCLUDED.unique_traders,
        unique_buyers = EXCLUDED.unique_buyers,
        unique_sellers = EXCLUDED.unique_sellers,
        observation_count = EXCLUDED.observation_count,
        average_confidence = EXCLUDED.average_confidence,
        first_slot = EXCLUDED.first_slot,
        last_slot = EXCLUDED.last_slot,
        provider = EXCLUDED.provider,
        updated_at = NOW()`,
      [strategyVersion, intervalMinutes]
    );
    return result.rowCount ?? 0;
  }

  async materializeHistoricalWalletFlowEvidence(strategyVersion: string): Promise<number> {
    const result = await this.pool.query(
      `WITH flows AS (
        SELECT
          e.idempotency_key,
          e.repeat_wallet_count,
          COUNT(o.idempotency_key)::int AS swaps_5m,
          COUNT(o.idempotency_key) FILTER (WHERE o.side = 'buy')::int AS buys_5m,
          COUNT(o.idempotency_key) FILTER (WHERE o.side = 'sell')::int AS sells_5m,
          COUNT(DISTINCT o.trader_address)
            FILTER (WHERE o.side = 'buy')::int AS unique_buyers_5m,
          COUNT(DISTINCT o.trader_address)
            FILTER (WHERE o.side = 'sell')::int AS unique_sellers_5m,
          COALESCE(SUM(o.quote_amount), 0)::float AS volume_5m_sol,
          COALESCE(SUM(o.volume_usd_estimate), 0)::float AS volume_5m_usd,
          COALESCE(AVG(o.confidence), 0)::float AS average_confidence,
          COALESCE(
            (
              MAX(o.price_quote) / NULLIF(MIN(o.price_quote), 0) - 1
            ) * 100,
            0
          )::float AS price_range_pct
        FROM wallet_entry_signals e
        LEFT JOIN canonical_historical_market_observations o
          ON o.token_address = e.token_address
         AND o.strategy_version = e.strategy_version
         AND o.observed_at >= e.observed_at - INTERVAL '5 minutes'
         AND o.observed_at <= e.observed_at
         AND (
           e.pool_address IS NULL
           OR o.pool_address IS NULL
           OR o.pool_address = e.pool_address
         )
        WHERE e.provider = 'helius-history'
          AND e.strategy_version = $1
        GROUP BY e.idempotency_key, e.repeat_wallet_count
      ),
      classified AS (
        SELECT
          *,
          buys_5m::float / GREATEST(swaps_5m, 1) AS buy_share_5m,
          (
            swaps_5m BETWEEN 5 AND 100
            AND buys_5m::float / GREATEST(swaps_5m, 1) BETWEEN 0.5 AND 0.85
            AND unique_buyers_5m >= 3
            AND average_confidence >= 0.65
          ) AS balanced_flow
        FROM flows
      )
      UPDATE wallet_entry_signals e
      SET
        cohort = CASE
          WHEN c.balanced_flow AND c.repeat_wallet_count >= 2
            THEN 'repeat-wallet+balanced-flow'
          WHEN c.balanced_flow
            THEN 'balanced-flow-control'
          ELSE 'excluded-uncontrolled-flow'
        END,
        flow_evidence = e.flow_evidence || jsonb_build_object(
          'source', 'helius-history-pre-entry-window',
          'historicalFlowVersion', 'pre-entry-5m-v1',
          'controlledFlow', false,
          'balancedFlow', c.balanced_flow,
          'liquidityKnown', false,
          'liquidityUsd', 0,
          'volume5mSol', c.volume_5m_sol,
          'volume5mUsd', c.volume_5m_usd,
          'buys5m', c.buys_5m,
          'sells5m', c.sells_5m,
          'swaps5m', c.swaps_5m,
          'buyShare5m', c.buy_share_5m,
          'uniqueBuyers5m', c.unique_buyers_5m,
          'uniqueSellers5m', c.unique_sellers_5m,
          'averagePriceConfidence5m', c.average_confidence,
          'priceRange5mPct', c.price_range_pct,
          'volumeLiquidityRatio', 0
        )
      FROM classified c
      WHERE e.idempotency_key = c.idempotency_key`,
      [strategyVersion]
    );
    return result.rowCount ?? 0;
  }

  async saveWalletEntrySignal(signal: WalletEntrySignalEvidence): Promise<boolean> {
    const unqualifiedWork = classifyWalletAlphaEntryWork(signal);
    const qualifiedWork = classifyWalletAlphaEntryWork(signal, "watch");
    const result = await this.pool.query(
      `WITH stale_exploratory_entry AS (
        SELECT idempotency_key
        FROM wallet_entry_signals
        WHERE chain = $2
          AND wallet_address = $3
          AND token_address = $4
          AND strategy_version = $16
          AND source_swap_idempotency_key IS NULL
          AND $6::text IS NOT NULL
      ), discarded_outcomes AS (
        DELETE FROM wallet_signal_outcomes
        WHERE entry_idempotency_key IN (
          SELECT idempotency_key FROM stale_exploratory_entry
        )
      ), changed AS (
      INSERT INTO wallet_entry_signals (
        idempotency_key, chain, wallet_address, token_address, pool_address,
        source_swap_idempotency_key,
        observed_entry_price_usd, observed_liquidity_usd, cohort, repeat_wallet_count,
        flow_evidence, signature, slot, provider, observed_at, strategy_version
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (chain, wallet_address, token_address, strategy_version)
      DO UPDATE SET
        pool_address = EXCLUDED.pool_address,
        source_swap_idempotency_key = EXCLUDED.source_swap_idempotency_key,
        observed_entry_price_usd = EXCLUDED.observed_entry_price_usd,
        observed_liquidity_usd = EXCLUDED.observed_liquidity_usd,
        cohort = EXCLUDED.cohort,
        repeat_wallet_count = EXCLUDED.repeat_wallet_count,
        flow_evidence = EXCLUDED.flow_evidence,
        signature = EXCLUDED.signature,
        slot = EXCLUDED.slot,
        provider = EXCLUDED.provider,
        observed_at = EXCLUDED.observed_at
      WHERE wallet_entry_signals.source_swap_idempotency_key IS NULL
        AND EXCLUDED.source_swap_idempotency_key IS NOT NULL
      RETURNING chain, wallet_address, strategy_version
      ), classified AS MATERIALIZED (
        SELECT
          changed.*,
          CASE
            WHEN latest_score.status IN ('watch', 'candidate', 'validated-paper')
              THEN $17::smallint
            ELSE $19::smallint
          END AS work_priority,
          CASE
            WHEN latest_score.status IN ('watch', 'candidate', 'validated-paper')
              THEN $18::text
            ELSE $20::text
          END AS work_reason
        FROM changed
        LEFT JOIN LATERAL (
          SELECT score.status
          FROM wallet_alpha_scores score
          WHERE score.chain = changed.chain
            AND score.wallet_address = changed.wallet_address
            AND score.strategy_version = changed.strategy_version
          ORDER BY score.calculated_at DESC
          LIMIT 1
        ) latest_score ON TRUE
      ), queued AS MATERIALIZED (
        SELECT enqueue_wallet_alpha_work(
          chain,
          wallet_address,
          strategy_version,
          work_priority,
          work_reason
        ) AS queued
        FROM classified
      )
      SELECT
        EXISTS(SELECT 1 FROM changed) AS changed,
        (SELECT COUNT(*) FROM queued) AS queued_count`,
      [
        signal.idempotencyKey,
        signal.chain,
        signal.walletAddress,
        signal.tokenAddress,
        signal.poolAddress ?? null,
        signal.sourceSwapIdempotencyKey ?? null,
        signal.observedEntryPriceUsd,
        signal.observedLiquidityUsd,
        signal.cohort,
        signal.repeatWalletCount,
        signal.flowEvidence,
        signal.signature,
        signal.slot,
        signal.provider,
        signal.observedAt,
        signal.strategyVersion,
        qualifiedWork.priority,
        qualifiedWork.reason,
        unqualifiedWork.priority,
        unqualifiedWork.reason
      ]
    );
    return Boolean(result.rows[0]?.changed);
  }

  async saveWalletSignalOutcome(outcome: WalletSignalOutcomeEvidence): Promise<boolean> {
    return (await this.saveWalletSignalOutcomes([outcome])) === 1;
  }

  async saveWalletSignalOutcomes(outcomes: WalletSignalOutcomeEvidence[]): Promise<number> {
    if (outcomes.length === 0) return 0;
    if (outcomes.length > 500) {
      throw new Error("Wallet outcome batch exceeds the 500-row repository ceiling.");
    }
    const conflictKeys = new Set<string>();
    const records = outcomes.map((outcome) => {
      const conflictKey = [
        outcome.entryIdempotencyKey,
        outcome.horizonMinutes,
        outcome.exitStrategy,
        outcome.strategyVersion
      ].join(":");
      if (conflictKeys.has(conflictKey)) {
        throw new Error(`Duplicate wallet outcome conflict key in batch: ${conflictKey}`);
      }
      conflictKeys.add(conflictKey);
      return {
        idempotency_key: outcome.idempotencyKey,
        entry_idempotency_key: outcome.entryIdempotencyKey,
        chain: outcome.chain,
        horizon_minutes: outcome.horizonMinutes,
        status: outcome.status,
        outcome_price_usd: outcome.outcomePriceUsd ?? null,
        frozen_at: outcome.frozenAt ?? null,
        gross_return_pct: outcome.grossReturnPct ?? null,
        net_return_pct: outcome.netReturnPct ?? null,
        estimated_round_trip_cost_pct: outcome.estimatedRoundTripCostPct,
        exit_strategy: outcome.exitStrategy,
        rugged: outcome.rugged,
        signature: outcome.signature,
        slot: outcome.slot,
        provider: outcome.provider,
        observed_at: outcome.observedAt,
        strategy_version: outcome.strategyVersion,
        raw: outcome.raw
      };
    });
    const result = await this.pool.query<{ changed_count: number }>(
      `WITH input AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS outcome(
           idempotency_key text,
           entry_idempotency_key text,
           chain text,
           horizon_minutes integer,
           status text,
           outcome_price_usd numeric,
           frozen_at timestamptz,
           gross_return_pct numeric,
           net_return_pct numeric,
           estimated_round_trip_cost_pct numeric,
           exit_strategy text,
           rugged boolean,
           signature text,
           slot bigint,
           provider text,
           observed_at timestamptz,
           strategy_version text,
           raw jsonb
         )
       ), changed AS (
       INSERT INTO wallet_signal_outcomes (
        idempotency_key, entry_idempotency_key, chain, horizon_minutes, status,
        outcome_price_usd, frozen_at, gross_return_pct, net_return_pct,
        estimated_round_trip_cost_pct, exit_strategy, rugged, signature, slot,
        provider, observed_at, strategy_version, raw
      )
      SELECT
        idempotency_key, entry_idempotency_key, chain, horizon_minutes, status,
        outcome_price_usd, frozen_at, gross_return_pct, net_return_pct,
        estimated_round_trip_cost_pct, exit_strategy, rugged, signature, slot,
        provider, observed_at, strategy_version, raw
      FROM input
      ON CONFLICT (entry_idempotency_key, horizon_minutes, exit_strategy, strategy_version)
      DO UPDATE SET
        status = CASE
          WHEN wallet_signal_outcomes.status = 'mature' THEN wallet_signal_outcomes.status
          ELSE EXCLUDED.status
        END,
        outcome_price_usd = CASE
          WHEN wallet_signal_outcomes.status = 'mature' THEN wallet_signal_outcomes.outcome_price_usd
          ELSE EXCLUDED.outcome_price_usd
        END,
        frozen_at = CASE
          WHEN wallet_signal_outcomes.status = 'mature' THEN wallet_signal_outcomes.frozen_at
          ELSE EXCLUDED.frozen_at
        END,
        gross_return_pct = CASE
          WHEN wallet_signal_outcomes.status = 'mature' THEN wallet_signal_outcomes.gross_return_pct
          ELSE EXCLUDED.gross_return_pct
        END,
        net_return_pct = CASE
          WHEN wallet_signal_outcomes.status = 'mature' THEN wallet_signal_outcomes.net_return_pct
          ELSE EXCLUDED.net_return_pct
        END,
        rugged = CASE
          WHEN wallet_signal_outcomes.status = 'mature' THEN wallet_signal_outcomes.rugged
          ELSE EXCLUDED.rugged
        END,
        signature = CASE
          WHEN wallet_signal_outcomes.status = 'mature' THEN wallet_signal_outcomes.signature
          ELSE EXCLUDED.signature
        END,
        slot = CASE
          WHEN wallet_signal_outcomes.status = 'mature' THEN wallet_signal_outcomes.slot
          ELSE EXCLUDED.slot
        END,
        provider = CASE
          WHEN wallet_signal_outcomes.status = 'mature' THEN wallet_signal_outcomes.provider
          ELSE EXCLUDED.provider
        END,
        observed_at = CASE
          WHEN wallet_signal_outcomes.status = 'mature' THEN wallet_signal_outcomes.observed_at
          ELSE EXCLUDED.observed_at
        END,
        raw = CASE
          WHEN wallet_signal_outcomes.status = 'mature' THEN wallet_signal_outcomes.raw
          ELSE EXCLUDED.raw
        END
      WHERE (
          (wallet_signal_outcomes.status = 'provisional'
            AND EXCLUDED.status IN ('unresolved', 'mature'))
          OR (wallet_signal_outcomes.status = 'unresolved'
            AND EXCLUDED.status = 'mature')
        )
        AND ROW(
          wallet_signal_outcomes.status,
          wallet_signal_outcomes.outcome_price_usd,
          wallet_signal_outcomes.frozen_at,
          wallet_signal_outcomes.gross_return_pct,
          wallet_signal_outcomes.net_return_pct,
          wallet_signal_outcomes.rugged,
          wallet_signal_outcomes.signature,
          wallet_signal_outcomes.slot,
          wallet_signal_outcomes.provider,
          wallet_signal_outcomes.observed_at,
          wallet_signal_outcomes.raw
        ) IS DISTINCT FROM ROW(
          EXCLUDED.status,
          EXCLUDED.outcome_price_usd,
          EXCLUDED.frozen_at,
          EXCLUDED.gross_return_pct,
          EXCLUDED.net_return_pct,
          EXCLUDED.rugged,
          EXCLUDED.signature,
          EXCLUDED.slot,
          EXCLUDED.provider,
          EXCLUDED.observed_at,
          EXCLUDED.raw
        )
      RETURNING entry_idempotency_key, chain, strategy_version
      ), changed_wallets AS (
        SELECT DISTINCT entry.chain, entry.wallet_address, changed.strategy_version
        FROM changed
        JOIN wallet_entry_signals entry
          ON entry.idempotency_key = changed.entry_idempotency_key
      ), queued AS MATERIALIZED (
        SELECT enqueue_wallet_alpha_work(
          chain,
          wallet_address,
          strategy_version,
          1::smallint,
          'signal-outcome'
        ) AS queued
        FROM changed_wallets
      )
      SELECT
        COUNT(*)::integer AS changed_count,
        (SELECT COUNT(*) FROM queued) AS queued_count
      FROM changed`,
      [JSON.stringify(records)]
    );
    return Number(result.rows[0]?.changed_count ?? 0);
  }

  async saveHypothesisRun(run: HypothesisRunEvidence): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO hypothesis_runs (
        idempotency_key, run_id, chain, hypothesis_key, cohort, verdict,
        signal_keys, metrics, decision_reason, signature, slot, provider,
        observed_at, strategy_version
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT DO NOTHING`,
      [
        run.idempotencyKey,
        run.runId,
        run.chain,
        run.hypothesisKey,
        run.cohort,
        run.verdict,
        JSON.stringify(run.signalKeys),
        run.metrics,
        run.decisionReason,
        run.signature,
        run.slot,
        run.provider,
        run.observedAt,
        run.strategyVersion
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async upsertIngestionCursor(cursor: IngestionCursorEvidence): Promise<void> {
    await this.pool.query(
      `INSERT INTO ingestion_cursors (
        source, address, chain, last_signature, last_slot, idempotency_key,
        signature, slot, provider, observed_at, strategy_version, last_event_occurred_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (source, address) DO UPDATE SET
        last_signature = EXCLUDED.last_signature,
        last_slot = EXCLUDED.last_slot,
        idempotency_key = EXCLUDED.idempotency_key,
        signature = EXCLUDED.signature,
        slot = EXCLUDED.slot,
        provider = EXCLUDED.provider,
        observed_at = EXCLUDED.observed_at,
        strategy_version = EXCLUDED.strategy_version,
        last_event_occurred_at = EXCLUDED.last_event_occurred_at
      WHERE ingestion_cursors.last_slot <= EXCLUDED.last_slot`,
      [
        cursor.source,
        cursor.address,
        cursor.chain,
        cursor.lastSignature,
        cursor.lastSlot,
        cursor.idempotencyKey,
        cursor.signature,
        cursor.slot,
        cursor.provider,
        cursor.observedAt,
        cursor.strategyVersion,
        cursor.lastEventOccurredAt ?? null
      ]
    );
  }

  async getIngestionCursor(
    source: string,
    address: string
  ): Promise<IngestionCursorEvidence | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM ingestion_cursors WHERE source = $1 AND address = $2`,
      [source, address]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? rowToIngestionCursor(row) : undefined;
  }

  async listPriceObservations(
    tokenAddress?: string,
    strategyVersion?: string,
    minObservedAt?: string
  ): Promise<PriceObservationEvidence[]> {
    let query = `SELECT * FROM price_observations WHERE 1=1`;
    const params: string[] = [];
    if (tokenAddress) {
      params.push(tokenAddress);
      query += ` AND token_address = $${params.length}`;
    }
    if (strategyVersion) {
      params.push(strategyVersion);
      query += ` AND strategy_version = $${params.length}`;
    }
    if (minObservedAt) {
      params.push(minObservedAt);
      query += ` AND observed_at >= $${params.length}`;
    }
    query += ` ORDER BY observed_at`;
    const result = await this.pool.query(query, params);
    return result.rows.map((row) => rowToPriceObservation(row));
  }

  async listPendingOnchainBuySwaps(
    tokenAddress?: string,
    limit = 250
  ): Promise<OnchainSwapEvidence[]> {
    const result = await this.pool.query(
      `SELECT s.*
       FROM swaps s
       JOIN (
         SELECT unique_pending.id, unique_pending.observed_at
         FROM (
           SELECT DISTINCT ON (
             candidate.chain,
             candidate.trader_address,
             candidate.output_token_address,
             candidate.strategy_version
           )
             candidate.id,
             candidate.chain,
             candidate.trader_address,
             candidate.output_token_address,
             candidate.strategy_version,
             candidate.observed_at
           FROM swaps candidate
           WHERE ($1::text IS NULL OR candidate.output_token_address = $1)
           AND NOT EXISTS (
             SELECT 1
             FROM wallet_entry_signals e
             WHERE e.chain = candidate.chain
               AND e.wallet_address = candidate.trader_address
               AND e.token_address = candidate.output_token_address
               AND e.strategy_version = candidate.strategy_version
               AND e.source_swap_idempotency_key IS NOT NULL
           )
           ORDER BY
             candidate.chain,
             candidate.trader_address,
             candidate.output_token_address,
             candidate.strategy_version,
             candidate.observed_at
         ) unique_pending
         ORDER BY unique_pending.observed_at
         LIMIT $2
       ) selected ON selected.id = s.id
       ORDER BY selected.observed_at`,
      [tokenAddress ?? null, clampLimit(limit, 250, 1_000)]
    );
    return result.rows.map((row) => rowToOnchainSwap(row));
  }

  async countPriorWalletEntryTokens(
    walletAddress: string,
    beforeObservedAt: string,
    strategyVersion: string
  ): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(DISTINCT token_address)::int AS token_count
       FROM wallet_entry_signals
       WHERE wallet_address = $1
         AND observed_at < $2
         AND strategy_version = $3`,
      [walletAddress, beforeObservedAt, strategyVersion]
    );
    return Number(result.rows[0]?.token_count ?? 0);
  }

  async listWalletEntrySignals(
    walletAddress?: string,
    strategyVersion?: string,
    minObservedAt?: string
  ): Promise<WalletEntrySignalEvidence[]> {
    let query = `SELECT * FROM wallet_entry_signals WHERE 1=1`;
    const params: string[] = [];
    if (walletAddress) {
      params.push(walletAddress);
      query += ` AND wallet_address = $${params.length}`;
    }
    if (strategyVersion) {
      params.push(strategyVersion);
      query += ` AND strategy_version = $${params.length}`;
    }
    if (minObservedAt) {
      params.push(minObservedAt);
      query += ` AND observed_at >= $${params.length}`;
    }
    query += ` ORDER BY observed_at`;
    const result = await this.pool.query(query, params);
    return result.rows.map((row) => rowToWalletEntrySignal(row));
  }

  async listWalletEntrySignalsForWallets(
    walletAddresses: string[],
    strategyVersion: string,
    minObservedAt?: string,
    maxRows?: number
  ): Promise<WalletEntrySignalEvidence[]> {
    if (walletAddresses.length === 0) return [];
    const result = await this.pool.query(
      `SELECT * FROM wallet_entry_signals
       WHERE wallet_address = ANY($1::text[])
         AND strategy_version = $2
         AND ($3::timestamptz IS NULL OR observed_at >= $3)
       ORDER BY wallet_address, observed_at, idempotency_key
       LIMIT $4`,
      [walletAddresses, strategyVersion, minObservedAt ?? null, maxRows ?? null]
    );
    return result.rows.map((row) => rowToWalletEntrySignal(row));
  }

  async listWalletTradeEvents(
    walletAddress?: string,
    strategyVersion?: string,
    minObservedAt?: string
  ): Promise<WalletTradeEvidence[]> {
    let query = `SELECT * FROM wallet_trade_events WHERE 1=1`;
    const params: string[] = [];
    if (walletAddress) {
      params.push(walletAddress);
      query += ` AND wallet_address = $${params.length}`;
    }
    if (strategyVersion) {
      params.push(strategyVersion);
      query += ` AND strategy_version = $${params.length}`;
    }
    if (minObservedAt) {
      params.push(minObservedAt);
      query += ` AND observed_at >= $${params.length}`;
    }
    query += ` ORDER BY observed_at`;
    const result = await this.pool.query(query, params);
    return result.rows.map((row) => rowToWalletTradeEvent(row));
  }

  async listWalletTradeEventsForWallets(
    walletAddresses: string[],
    strategyVersion: string,
    minObservedAt?: string,
    maxRows?: number
  ): Promise<WalletTradeEvidence[]> {
    if (walletAddresses.length === 0) return [];
    if (walletAddresses.length === 1) {
      const result = await this.pool.query(
        `SELECT * FROM wallet_trade_events
         WHERE wallet_address = $1
           AND strategy_version = $2
           AND ($3::timestamptz IS NULL OR observed_at >= $3)
         ORDER BY observed_at, slot, idempotency_key
         LIMIT $4`,
        [walletAddresses[0], strategyVersion, minObservedAt ?? null, maxRows ?? null]
      );
      return result.rows.map((row) => rowToWalletTradeEvent(row));
    }
    const result = await this.pool.query(
      `SELECT * FROM wallet_trade_events
       WHERE wallet_address = ANY($1::text[])
         AND strategy_version = $2
         AND ($3::timestamptz IS NULL OR observed_at >= $3)
       ORDER BY wallet_address, observed_at, slot, idempotency_key
       LIMIT $4`,
      [walletAddresses, strategyVersion, minObservedAt ?? null, maxRows ?? null]
    );
    return result.rows.map((row) => rowToWalletTradeEvent(row));
  }

  async listWalletAlphaScores(
    strategyVersion?: string,
    limit = 100
  ): Promise<WalletAlphaScoreSnapshot[]> {
    const boundedLimit = clampLimit(limit, 100, 5_000);
    if (strategyVersion) {
      const result = await this.pool.query(
        `WITH latest AS (
           SELECT DISTINCT ON (strategy_version, chain, wallet_address) *
           FROM wallet_alpha_scores
           WHERE strategy_version = $1
           ORDER BY strategy_version, chain, wallet_address, calculated_at DESC
         )
         SELECT * FROM latest
         ORDER BY
           CASE status
             WHEN 'validated-paper' THEN 4
             WHEN 'candidate' THEN 3
             WHEN 'watch' THEN 2
             WHEN 'observed' THEN 1
             WHEN 'insufficient' THEN 0
             ELSE -1
           END DESC,
           overall_score DESC,
           completed_positions DESC,
           wallet_address
         LIMIT $2`,
        [strategyVersion, boundedLimit]
      );
      return result.rows.map((row) => rowToWalletAlphaScore(row));
    }
    const result = await this.pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (chain, wallet_address, strategy_version) *
         FROM wallet_alpha_scores
         WHERE ($1::text IS NULL OR strategy_version = $1)
         ORDER BY chain, wallet_address, strategy_version, calculated_at DESC
       )
       SELECT * FROM latest
       ORDER BY
         CASE status
           WHEN 'validated-paper' THEN 4
           WHEN 'candidate' THEN 3
           WHEN 'watch' THEN 2
           WHEN 'observed' THEN 1
           WHEN 'insufficient' THEN 0
           ELSE -1
         END DESC,
         overall_score DESC,
         completed_positions DESC,
         wallet_address
       LIMIT $2`,
      [null, boundedLimit]
    );
    return result.rows.map((row) => rowToWalletAlphaScore(row));
  }

  async listWalletAlphaSignals(
    strategyVersion?: string,
    limit = 100
  ): Promise<WalletAlphaSignalEvidence[]> {
    const result = await this.pool.query(
      `SELECT * FROM wallet_alpha_signals
       WHERE ($1::text IS NULL OR strategy_version = $1)
       ORDER BY detected_at DESC
       LIMIT $2`,
      [strategyVersion ?? null, limit]
    );
    return result.rows.map((row) => rowToWalletAlphaSignal(row));
  }

  async listWalletSignalOutcomes(
    status?: WalletSignalOutcomeEvidence["status"],
    strategyVersion?: string,
    minObservedAt?: string
  ): Promise<WalletSignalOutcomeEvidence[]> {
    let query = `SELECT * FROM wallet_signal_outcomes WHERE 1=1`;
    const params: string[] = [];
    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    if (strategyVersion) {
      params.push(strategyVersion);
      query += ` AND strategy_version = $${params.length}`;
    }
    if (minObservedAt) {
      params.push(minObservedAt);
      query += ` AND observed_at >= $${params.length}`;
    }
    query += ` ORDER BY observed_at`;
    const result = await this.pool.query(query, params);
    return result.rows.map((row) => rowToWalletSignalOutcome(row));
  }

  async listWalletSignalOutcomesForWallets(
    walletAddresses: string[],
    strategyVersion: string,
    minObservedAt?: string,
    maxRows?: number
  ): Promise<WalletSignalOutcomeEvidence[]> {
    if (walletAddresses.length === 0) return [];
    const result = await this.pool.query(
      `SELECT outcome.*
       FROM wallet_signal_outcomes outcome
       JOIN wallet_entry_signals entry
         ON entry.idempotency_key = outcome.entry_idempotency_key
       WHERE entry.wallet_address = ANY($1::text[])
         AND entry.strategy_version = $2
         AND outcome.strategy_version = $2
         AND ($3::timestamptz IS NULL OR outcome.observed_at >= $3)
       ORDER BY entry.wallet_address, outcome.observed_at, outcome.idempotency_key
       LIMIT $4`,
      [walletAddresses, strategyVersion, minObservedAt ?? null, maxRows ?? null]
    );
    return result.rows.map((row) => rowToWalletSignalOutcome(row));
  }

  async listHypothesisRuns(hypothesisKey?: string): Promise<HypothesisRunEvidence[]> {
    const result = hypothesisKey
      ? await this.pool.query(
          `SELECT * FROM hypothesis_runs WHERE hypothesis_key = $1 ORDER BY observed_at`,
          [hypothesisKey]
        )
      : await this.pool.query(`SELECT * FROM hypothesis_runs ORDER BY observed_at`);
    return result.rows.map((row) => rowToHypothesisRun(row));
  }

  async assertReady(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async admitSolanaSignature(item: DurableSolanaSignature): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO solana_signature_queue (
         provider, address, signature, slot, notified_at
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, address, signature) DO UPDATE SET
         slot = GREATEST(solana_signature_queue.slot, EXCLUDED.slot),
         notified_at = LEAST(solana_signature_queue.notified_at, EXCLUDED.notified_at),
         updated_at = NOW()
       WHERE solana_signature_queue.status = 'pending'
       RETURNING status = 'pending' AS pending`,
      [item.provider, item.address, item.signature, item.slot, item.notifiedAt]
    );
    return Boolean(result.rows[0]?.pending);
  }

  async listPendingSolanaSignatures(
    provider: string,
    address: string,
    limit: number
  ): Promise<DurableSolanaSignature[]> {
    const result = await this.pool.query(
      `SELECT provider, address, signature, slot, notified_at
       FROM solana_signature_queue
       WHERE provider = $1 AND address = $2 AND status = 'pending'
       ORDER BY slot, notified_at, signature
       LIMIT $3`,
      [provider, address, clampLimit(limit, 500, 5_000)]
    );
    return result.rows.map((row) => ({
      provider: String(row.provider),
      address: String(row.address),
      signature: String(row.signature),
      slot: Number(row.slot),
      notifiedAt: new Date(String(row.notified_at)).toISOString()
    }));
  }

  async completeSolanaSignature(
    provider: string,
    address: string,
    signature: string,
    completedAt = new Date().toISOString()
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE solana_signature_queue
       SET status = 'completed', completed_at = $4, updated_at = NOW()
       WHERE provider = $1 AND address = $2 AND signature = $3 AND status = 'pending'`,
      [provider, address, signature, completedAt]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getSolanaSignatureQueueSummary(
    provider?: string
  ): Promise<DurableSolanaSignatureQueueSummary> {
    const result = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending_count,
         COUNT(*) FILTER (WHERE status = 'completed')::integer AS completed_count,
         MIN(notified_at) FILTER (WHERE status = 'pending') AS oldest_pending_at
       FROM solana_signature_queue
       WHERE ($1::text IS NULL OR provider = $1)`,
      [provider ?? null]
    );
    const row = result.rows[0];
    return {
      pendingCount: Number(row?.pending_count ?? 0),
      completedCount: Number(row?.completed_count ?? 0),
      ...(row?.oldest_pending_at
        ? { oldestPendingAt: new Date(String(row.oldest_pending_at)).toISOString() }
        : {})
    };
  }

  async listPendingSolanaFinalities(
    limit: number,
    minimumAgeSeconds: number
  ): Promise<SolanaFinalityWorkItem[]> {
    const result = await this.pool.query(
      `SELECT chain, signature, slot, first_seen_at, attempt_count
       FROM solana_transaction_finality
       WHERE status = 'pending'
         AND first_seen_at <= NOW() - ($2 * INTERVAL '1 second')
       ORDER BY slot, first_seen_at, signature
       LIMIT $1`,
      [clampLimit(limit, 256, 256), Math.max(0, Math.trunc(minimumAgeSeconds))]
    );
    return result.rows.map((row) => ({
      chain: "solana",
      signature: String(row.signature),
      slot: Number(row.slot),
      firstSeenAt: new Date(String(row.first_seen_at)).toISOString(),
      attemptCount: Number(row.attempt_count)
    }));
  }

  async reconcileTerminalSolanaFinalityEvents(limit: number): Promise<SolanaFinalityBatchResult> {
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT event.idempotency_key,
                finality.status AS finality_status,
                finality.finalized_at,
                finality.last_error
         FROM chain_event_inbox AS event
         JOIN solana_transaction_finality AS finality
           ON finality.chain = event.chain
          AND finality.signature = event.signature
         WHERE event.chain = 'solana'
           AND event.finality_required = TRUE
           AND event.status IN ('pending', 'retry')
           AND finality.status IN ('finalized', 'failed', 'unresolved')
           AND (
             (finality.status = 'finalized' AND event.commitment <> 'finalized')
             OR finality.status IN ('failed', 'unresolved')
           )
         ORDER BY event.received_at, event.signature, event.idempotency_key
         FOR UPDATE OF event SKIP LOCKED
         LIMIT $1
       ), affected AS (
         UPDATE chain_event_inbox AS event
         SET commitment = CASE
               WHEN candidates.finality_status = 'finalized' THEN 'finalized'
               ELSE event.commitment
             END,
             finalized_at = CASE
               WHEN candidates.finality_status = 'finalized'
                 THEN candidates.finalized_at
               ELSE event.finalized_at
             END,
             status = CASE
               WHEN candidates.finality_status IN ('failed', 'unresolved') THEN 'rolled_back'
               ELSE event.status
             END,
             last_error = CASE
               WHEN candidates.finality_status IN ('failed', 'unresolved')
                 THEN COALESCE(candidates.last_error, 'Solana finality failed closed.')
               ELSE event.last_error
             END,
             locked_by = NULL,
             locked_at = NULL,
             lock_expires_at = NULL
         FROM candidates
         WHERE event.idempotency_key = candidates.idempotency_key
         RETURNING candidates.finality_status
       )
       SELECT
         0::integer AS checked_signatures,
         COUNT(*) FILTER (WHERE finality_status = 'finalized')::integer AS finalized_events,
         COUNT(*) FILTER (WHERE finality_status IN ('failed', 'unresolved'))::integer
           AS rolled_back_events
       FROM affected`,
      [clampLimit(limit, 256, 256)]
    );
    const row = result.rows[0];
    return {
      checkedSignatures: 0,
      finalizedEvents: Number(row?.finalized_events ?? 0),
      rolledBackEvents: Number(row?.rolled_back_events ?? 0)
    };
  }

  async recordSolanaFinalities(
    results: Array<{ signature: string; result: SolanaFinalityResult }>
  ): Promise<SolanaFinalityBatchResult> {
    if (results.length === 0) {
      return { checkedSignatures: 0, finalizedEvents: 0, rolledBackEvents: 0 };
    }
    const records = results.map(({ signature, result }) => ({
      signature,
      status: result.status,
      checked_at: result.checkedAt,
      confirmation_status: result.confirmationStatus ?? null,
      root_slot: result.rootSlot ?? null,
      error: result.error ?? null
    }));
    const query = await this.pool.query(
      `WITH input AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS item(
           signature text,
           status text,
           checked_at timestamptz,
           confirmation_status text,
           root_slot bigint,
           error text
         )
       ), updated AS (
         UPDATE solana_transaction_finality AS finality
         SET status = input.status,
             attempt_count = finality.attempt_count + 1,
             last_checked_at = input.checked_at,
             finalized_at = CASE
               WHEN input.status = 'finalized' THEN input.checked_at
               ELSE finality.finalized_at
             END,
             confirmation_status = COALESCE(
               input.confirmation_status,
               finality.confirmation_status
             ),
             root_slot = COALESCE(input.root_slot, finality.root_slot),
             last_error = input.error,
             updated_at = NOW()
         FROM input
         WHERE finality.chain = 'solana'
           AND finality.signature = input.signature
           AND finality.status = 'pending'
         RETURNING finality.signature, finality.status, finality.finalized_at,
                   finality.last_error
       ), affected AS (
         UPDATE chain_event_inbox AS event
         SET commitment = CASE
               WHEN updated.status = 'finalized' THEN 'finalized'
               ELSE event.commitment
             END,
             finalized_at = CASE
               WHEN updated.status = 'finalized' THEN updated.finalized_at
               ELSE event.finalized_at
             END,
             status = CASE
               WHEN updated.status IN ('failed', 'unresolved') THEN 'rolled_back'
               ELSE event.status
             END,
             last_error = CASE
               WHEN updated.status IN ('failed', 'unresolved')
                 THEN COALESCE(updated.last_error, 'Solana finality failed closed.')
               ELSE event.last_error
             END,
             locked_by = NULL,
             locked_at = NULL,
             lock_expires_at = NULL
         FROM updated
         WHERE event.chain = 'solana'
           AND event.signature = updated.signature
           AND event.finality_required = TRUE
           AND event.status IN ('pending', 'retry')
           AND updated.status <> 'pending'
         RETURNING updated.status
       )
       SELECT
         (SELECT COUNT(*)::integer FROM updated) AS checked_signatures,
         COUNT(*) FILTER (WHERE status = 'finalized')::integer AS finalized_events,
         COUNT(*) FILTER (WHERE status IN ('failed', 'unresolved'))::integer
           AS rolled_back_events
       FROM affected`,
      [JSON.stringify(records)]
    );
    const row = query.rows[0];
    return {
      checkedSignatures: Number(row?.checked_signatures ?? 0),
      finalizedEvents: Number(row?.finalized_events ?? 0),
      rolledBackEvents: Number(row?.rolled_back_events ?? 0)
    };
  }

  async insertChainEvent(event: CanonicalChainEventInput): Promise<boolean> {
    const result = await this.insertChainEvents([event]);
    return result.inserted === 1;
  }

  async insertChainEvents(
    events: CanonicalChainEventInput[]
  ): Promise<{ inserted: number; duplicates: number }> {
    if (events.length === 0) return { inserted: 0, duplicates: 0 };
    const records = events.map((event) => {
      const payload = encodePostgresJsonPayload(event.payload);
      return {
        idempotency_key: event.idempotencyKey,
        chain: event.chain,
        signature: event.signature ?? null,
        slot: event.slot ?? null,
        transaction_index: event.transactionIndex ?? null,
        instruction_index: event.instructionIndex ?? null,
        inner_instruction_index: event.innerInstructionIndex ?? null,
        event_type: event.eventType,
        token_address: event.tokenAddress ?? null,
        pool_address: event.poolAddress ?? null,
        occurred_at: event.occurredAt,
        received_at: event.receivedAt,
        commitment: event.commitment,
        finality_required: event.requiresFinality ?? false,
        source: event.source,
        decoder_version: event.decoderVersion,
        payload
      };
    });
    const result = await this.pool.query(
      `WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS event(
          idempotency_key text,
          chain text,
          signature text,
          slot bigint,
          transaction_index integer,
          instruction_index integer,
          inner_instruction_index integer,
          event_type text,
          token_address text,
          pool_address text,
          occurred_at timestamptz,
          received_at timestamptz,
          commitment text,
          finality_required boolean,
          source text,
          decoder_version text,
          payload jsonb
        )
      ), inserted AS (
        INSERT INTO chain_event_inbox (
          idempotency_key, chain, signature, slot, transaction_index, instruction_index,
          inner_instruction_index, event_type, token_address, pool_address, occurred_at,
          received_at, commitment, source, decoder_version, partition_key, payload,
          payload_sha256, finality_required
        )
        SELECT
          event.idempotency_key, event.chain, event.signature, event.slot,
          event.transaction_index, event.instruction_index, event.inner_instruction_index,
          event.event_type, event.token_address, event.pool_address, event.occurred_at,
          event.received_at, event.commitment, event.source, event.decoder_version,
          COALESCE(NULLIF(event.payload->>'address', ''), event.source), '{}'::jsonb,
          encode(digest(event.payload::text, 'sha256'), 'hex'), event.finality_required
        FROM input AS event
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING idempotency_key, chain, signature, slot, received_at,
                  payload_sha256, finality_required
      ), payloads AS (
        INSERT INTO chain_event_payloads (
          event_idempotency_key, received_at, payload, payload_sha256
        )
        SELECT inserted.idempotency_key, inserted.received_at, input.payload,
               inserted.payload_sha256
        FROM inserted
        JOIN input ON input.idempotency_key = inserted.idempotency_key
        RETURNING event_idempotency_key
      ), finalities AS (
        INSERT INTO solana_transaction_finality (
          chain, signature, slot, first_seen_at
        )
        SELECT DISTINCT chain, signature, slot, received_at
        FROM inserted
        WHERE chain = 'solana'
          AND finality_required = TRUE
          AND signature IS NOT NULL
          AND slot IS NOT NULL
        ON CONFLICT (chain, signature) DO NOTHING
        RETURNING signature
      )
      SELECT COUNT(*)::integer AS inserted FROM inserted`,
      [JSON.stringify(records)]
    );
    const inserted = Number(result.rows[0]?.inserted ?? 0);
    return { inserted, duplicates: events.length - inserted };
  }

  async claimChainEvents(options: CanonicalEventClaimOptions): Promise<CanonicalChainEvent[]> {
    const limit = clampLimit(options.limit, 100, 1_000);
    const leaseSeconds = Math.max(1, Math.trunc(options.leaseSeconds ?? 30));
    const result = await this.pool.query(
      `WITH RECURSIVE partition_heads AS (
        (
          SELECT
            event.idempotency_key,
            event.chain,
            COALESCE(
              NULLIF(event.partition_key, ''),
              NULLIF(event.payload->>'address', ''),
              event.source
            ) AS partition_key,
            event.slot,
            event.transaction_index,
            event.instruction_index,
            event.received_at,
            event.status,
            event.attempt_count,
            event.next_attempt_at,
            event.lock_expires_at
          FROM chain_event_inbox AS event
          WHERE event.status NOT IN ('processed', 'rolled_back')
          ORDER BY
            event.chain,
            COALESCE(
              NULLIF(event.partition_key, ''),
              NULLIF(event.payload->>'address', ''),
              event.source
            ),
            event.slot ASC NULLS LAST,
            event.transaction_index ASC NULLS LAST,
            event.instruction_index ASC NULLS LAST,
            event.received_at ASC,
            event.idempotency_key ASC
          LIMIT 1
        )
        UNION ALL
        SELECT next_head.*
        FROM partition_heads AS previous
        CROSS JOIN LATERAL (
          SELECT
            event.idempotency_key,
            event.chain,
            COALESCE(
              NULLIF(event.partition_key, ''),
              NULLIF(event.payload->>'address', ''),
              event.source
            ) AS partition_key,
            event.slot,
            event.transaction_index,
            event.instruction_index,
            event.received_at,
            event.status,
            event.attempt_count,
            event.next_attempt_at,
            event.lock_expires_at
          FROM chain_event_inbox AS event
          WHERE event.status NOT IN ('processed', 'rolled_back')
            AND (
              event.chain,
              COALESCE(
                NULLIF(event.partition_key, ''),
                NULLIF(event.payload->>'address', ''),
                event.source
              )
            ) > (previous.chain, previous.partition_key)
          ORDER BY
            event.chain,
            COALESCE(
              NULLIF(event.partition_key, ''),
              NULLIF(event.payload->>'address', ''),
              event.source
            ),
            event.slot ASC NULLS LAST,
            event.transaction_index ASC NULLS LAST,
            event.instruction_index ASC NULLS LAST,
            event.received_at ASC,
            event.idempotency_key ASC
          LIMIT 1
        ) AS next_head
      ), candidates AS (
        SELECT
          event.idempotency_key,
          event.status AS previous_status,
          event.attempt_count AS previous_attempt_count
        FROM chain_event_inbox AS event
        JOIN partition_heads AS head
          ON head.idempotency_key = event.idempotency_key
        WHERE (
            (head.status IN ('pending', 'retry') AND head.next_attempt_at <= NOW())
            OR (head.status = 'processing' AND head.lock_expires_at <= NOW())
          )
          AND (NOT event.finality_required OR event.commitment = 'finalized')
        ORDER BY
          event.slot ASC NULLS LAST,
          event.transaction_index ASC NULLS LAST,
          event.instruction_index ASC NULLS LAST,
          event.received_at ASC,
          event.idempotency_key ASC
        FOR UPDATE OF event SKIP LOCKED
        LIMIT $1
      ), expired_attempts AS (
        UPDATE event_processing_attempts AS processing
        SET status = 'retry',
            finished_at = NOW(),
            error = 'processing lease expired'
        FROM candidates
        WHERE candidates.previous_status = 'processing'
          AND processing.event_idempotency_key = candidates.idempotency_key
          AND processing.attempt_number = candidates.previous_attempt_count
          AND processing.status = 'processing'
        RETURNING processing.event_idempotency_key
      ), claimed AS (
        UPDATE chain_event_inbox AS event
        SET status = 'processing',
            attempt_count = event.attempt_count + 1,
            locked_by = $2,
            locked_at = NOW(),
            lock_expires_at = NOW() + ($3 * INTERVAL '1 second'),
            last_error = NULL
        FROM candidates
        WHERE event.idempotency_key = candidates.idempotency_key
        RETURNING event.*
      ), attempts AS (
        INSERT INTO event_processing_attempts (
          event_idempotency_key, attempt_number, worker_id, status, started_at
        )
        SELECT idempotency_key, attempt_count, $2, 'processing', locked_at
        FROM claimed
        ON CONFLICT (event_idempotency_key, attempt_number) DO UPDATE SET
          worker_id = EXCLUDED.worker_id,
          status = 'processing',
          started_at = EXCLUDED.started_at,
          finished_at = NULL,
          error = NULL
        RETURNING event_idempotency_key
      )
      SELECT
        claimed.idempotency_key,
        claimed.chain,
        claimed.signature,
        claimed.slot,
        claimed.transaction_index,
        claimed.instruction_index,
        claimed.inner_instruction_index,
        claimed.event_type,
        claimed.token_address,
        claimed.pool_address,
        claimed.occurred_at,
        claimed.received_at,
        claimed.processed_at,
         claimed.finalized_at,
         claimed.commitment,
         claimed.finality_required,
         claimed.source,
        claimed.decoder_version,
        claimed.status,
        claimed.attempt_count,
        claimed.next_attempt_at,
        claimed.locked_by,
        claimed.locked_at,
        claimed.lock_expires_at,
        claimed.last_error,
        COALESCE(hot_payload.payload, held_payload.payload, claimed.payload) AS payload,
        claimed.payload_sha256,
        claimed.payload_compacted_at,
        claimed.partition_key
      FROM claimed
      JOIN attempts ON attempts.event_idempotency_key = claimed.idempotency_key
      LEFT JOIN chain_event_payloads AS hot_payload
        ON hot_payload.event_idempotency_key = claimed.idempotency_key
      LEFT JOIN chain_event_payload_holds AS held_payload
        ON held_payload.event_idempotency_key = claimed.idempotency_key
      ORDER BY claimed.slot ASC NULLS LAST, claimed.received_at ASC`,
      [limit, options.workerId, leaseSeconds]
    );
    return result.rows.map((row) => rowToCanonicalChainEvent(row));
  }

  async completeChainEvent(
    idempotencyKey: string,
    workerId: string,
    processedAt = new Date().toISOString()
  ): Promise<boolean> {
    const result = await this.pool.query(
      `WITH completed AS (
        UPDATE chain_event_inbox
        SET status = 'processed',
            processed_at = $3,
            finalized_at = CASE WHEN commitment = 'finalized' THEN $3 ELSE finalized_at END,
            locked_by = NULL,
            locked_at = NULL,
            lock_expires_at = NULL,
            last_error = NULL
        WHERE idempotency_key = $1
          AND status = 'processing'
          AND locked_by = $2
        RETURNING idempotency_key, attempt_count
      ), attempt AS (
        UPDATE event_processing_attempts AS processing
        SET status = 'succeeded', finished_at = $3, error = NULL
        FROM completed
        WHERE processing.event_idempotency_key = completed.idempotency_key
          AND processing.attempt_number = completed.attempt_count
        RETURNING processing.id
      )
      SELECT COUNT(*)::integer AS completed FROM completed`,
      [idempotencyKey, workerId, processedAt]
    );
    return Number(result.rows[0]?.completed ?? 0) === 1;
  }

  async failChainEvent(
    idempotencyKey: string,
    workerId: string,
    error: string,
    options: CanonicalEventFailureOptions = {}
  ): Promise<CanonicalEventFailureResult | undefined> {
    const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 5));
    const retryAt = options.retryAt ?? new Date(Date.now() + 5_000).toISOString();
    const result = await this.pool.query(
      `WITH failed AS (
        UPDATE chain_event_inbox
        SET status = CASE WHEN attempt_count >= $4 THEN 'dead_letter' ELSE 'retry' END,
            next_attempt_at = $5,
            locked_by = NULL,
            locked_at = NULL,
            lock_expires_at = NULL,
            last_error = $3
        WHERE idempotency_key = $1
          AND status = 'processing'
          AND locked_by = $2
        RETURNING idempotency_key, status, attempt_count
      ), attempt AS (
        UPDATE event_processing_attempts AS processing
        SET status = failed.status,
            finished_at = NOW(),
            error = $3
        FROM failed
        WHERE processing.event_idempotency_key = failed.idempotency_key
          AND processing.attempt_number = failed.attempt_count
        RETURNING processing.id
      )
      SELECT * FROM failed`,
      [idempotencyKey, workerId, error, maxAttempts, retryAt]
    );
    const row = result.rows[0];
    return row
      ? {
          idempotencyKey: String(row.idempotency_key),
          status: row.status as CanonicalEventFailureResult["status"],
          attemptCount: Number(row.attempt_count)
        }
      : undefined;
  }

  async upsertPipelineWatermark(watermark: PipelineWatermark): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO pipeline_watermarks (
        pipeline, partition_key, chain, last_contiguous_slot, last_signature,
        status, updated_at, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (pipeline, partition_key) DO UPDATE SET
        chain = EXCLUDED.chain,
        last_contiguous_slot = EXCLUDED.last_contiguous_slot,
        last_signature = EXCLUDED.last_signature,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        metadata = pipeline_watermarks.metadata || EXCLUDED.metadata
      WHERE pipeline_watermarks.last_contiguous_slot <= EXCLUDED.last_contiguous_slot
      RETURNING pipeline`,
      [
        watermark.pipeline,
        watermark.partitionKey,
        watermark.chain,
        watermark.lastContiguousSlot,
        watermark.lastSignature ?? null,
        watermark.status,
        watermark.updatedAt,
        watermark.metadata
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getPipelineWatermark(
    pipeline: string,
    partitionKey = "global"
  ): Promise<PipelineWatermark | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM pipeline_watermarks WHERE pipeline = $1 AND partition_key = $2`,
      [pipeline, partitionKey]
    );
    const row = result.rows[0];
    return row ? rowToPipelineWatermark(row) : undefined;
  }

  async openIngestionCoverageIncident(
    incident: IngestionCoverageIncidentOpenInput
  ): Promise<IngestionCoverageIncident> {
    const values = [
      incident.idempotencyKey,
      incident.chain,
      incident.provider,
      incident.programAddress,
      incident.reason,
      incident.gapStartedAt,
      incident.openedAt,
      incident.clusterSlot ?? null,
      incident.sourceSlot ?? null,
      incident.slotLag ?? null,
      incident.lastWebsocketMessageAt ?? null,
      incident.silenceMs ?? null,
      incident.subscriptionAckTimeoutCount,
      incident.successfulSubscriptionAckCount,
      incident.metadata
    ];
    return this.withTransaction(async (client) => {
      // Paper admission takes the same per-program transaction lock immediately
      // before recording an opening fill. This serializes a known incident with
      // that final side effect without increasing worker or provider concurrency.
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('walletscaner:discovery-coverage:' || $1::text, 0)
         )`,
        [incident.programAddress]
      );
      const inserted = await client.query(
        `INSERT INTO ingestion_coverage_incidents (
           idempotency_key, chain, provider, program_address, reason,
           gap_started_at, opened_at, cluster_slot, source_slot, slot_lag,
           last_websocket_message_at, silence_ms,
           subscription_ack_timeout_count, successful_subscription_ack_count,
           open_metadata
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15
         )
         ON CONFLICT DO NOTHING
         RETURNING *`,
        values
      );
      const existingById = inserted.rows[0]
        ? undefined
        : (
            await client.query(
              `SELECT * FROM ingestion_coverage_incidents
               WHERE idempotency_key = $1`,
              [incident.idempotencyKey]
            )
          ).rows[0];
      const conflictingOpen =
        inserted.rows[0] || existingById
          ? undefined
          : (
              await client.query(
                `SELECT * FROM ingestion_coverage_incidents
                 WHERE provider = $1 AND program_address = $2 AND closed_at IS NULL
                 ORDER BY opened_at DESC
                 LIMIT 1`,
                [incident.provider, incident.programAddress]
              )
            ).rows[0];
      const row = inserted.rows[0] ?? existingById ?? conflictingOpen;
      if (!row) throw new Error("Coverage incident could not be opened or recovered.");
      return rowToIngestionCoverageIncident(row);
    });
  }

  async listOpenIngestionCoverageIncidents(
    provider?: string
  ): Promise<IngestionCoverageIncident[]> {
    const result = provider
      ? await this.pool.query(
          `SELECT * FROM ingestion_coverage_incidents
           WHERE provider = $1 AND closed_at IS NULL
           ORDER BY opened_at, program_address`,
          [provider]
        )
      : await this.pool.query(
          `SELECT * FROM ingestion_coverage_incidents
           WHERE closed_at IS NULL
           ORDER BY opened_at, program_address`
        );
    return result.rows.map((row) => rowToIngestionCoverageIncident(row));
  }

  async markIngestionCoverageIncidentRestart(
    idempotencyKey: string,
    phase: "attempted" | "completed" | "failed",
    at: string,
    error?: string
  ): Promise<boolean> {
    const assignment =
      phase === "attempted"
        ? `restart_attempted_at = COALESCE(restart_attempted_at, $2::timestamptz),
           restart_attempt_count = restart_attempt_count + 1,
           last_restart_attempted_at = $2::timestamptz,
           last_restart_error = NULL`
        : phase === "completed"
          ? `restart_completed_at = COALESCE(restart_completed_at, $2::timestamptz),
             last_restart_completed_at = $2::timestamptz,
             last_restart_error = NULL`
          : `last_restart_attempted_at = COALESCE(last_restart_attempted_at, $2::timestamptz),
             last_restart_error = $3::text`;
    const result = await this.pool.query(
      `UPDATE ingestion_coverage_incidents
       SET ${assignment}
       WHERE idempotency_key = $1 AND closed_at IS NULL
       RETURNING idempotency_key`,
      phase === "failed"
        ? [idempotencyKey, at, error?.slice(0, 500) ?? "unknown error"]
        : [idempotencyKey, at]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async closeIngestionCoverageIncident(
    idempotencyKey: string,
    input: IngestionCoverageIncidentCloseInput
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ingestion_coverage_incidents
       SET closed_at = $2,
           close_cluster_slot = $3,
           close_source_slot = $4,
           resolution = 'transport_recovered_gap_unreconciled',
           close_metadata = $5,
           coverage_reconciled_at = $6,
           coverage_repair_id = $7
       WHERE idempotency_key = $1
         AND closed_at IS NULL
         AND (
           ($6::timestamptz IS NULL AND $7::text IS NULL)
           OR (
             $6::timestamptz IS NOT NULL
             AND $7::text IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM ingestion_gap_repairs repair
                JOIN ingestion_gap_repair_target_proofs proof
                  ON proof.repair_id = repair.repair_id
                WHERE repair.repair_id = $7
                AND repair.incident_id = $1
                AND proof.incident_id = $1
                AND repair.status = 'completed'
                AND repair.boundary_source = 'truncation_cursor'
                AND repair.covered_through_signature = repair.target_signature
                AND repair.covered_through_slot = repair.target_slot
                AND proof.target_signature = repair.target_signature
                AND proof.target_slot = repair.target_slot
                AND proof.confirmation_status = 'finalized'
              )
           )
         )
       RETURNING idempotency_key`,
      [
        idempotencyKey,
        input.closedAt,
        input.clusterSlot ?? null,
        input.sourceSlot ?? null,
        input.metadata,
        input.coverageReconciledAt ?? null,
        input.coverageRepairId ?? null
      ]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async getOrCreateIngestionGapRepair(
    input: IngestionGapRepairCreateInput
  ): Promise<IngestionGapRepair> {
    return this.withTransaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('walletscaner:discovery-gap-repair:' || $1::text, 0)
         )`,
        [input.incidentId]
      );
      const active = await client.query(
        `SELECT *
         FROM ingestion_gap_repairs
         WHERE incident_id = $1 AND status IN ('collecting', 'replaying')
         ORDER BY created_at DESC
         LIMIT 1`,
        [input.incidentId]
      );
      if (active.rows[0]) return rowToIngestionGapRepair(active.rows[0]);
      const inserted = await client.query(
        `INSERT INTO ingestion_gap_repairs (
           repair_id, incident_id, provider, program_address,
           cursor_signature, cursor_slot, cursor_occurred_at, boundary_source
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (repair_id) DO NOTHING
         RETURNING *`,
        [
          input.repairId,
          input.incidentId,
          input.provider,
          input.programAddress,
          input.cursorSignature,
          input.cursorSlot,
          input.cursorOccurredAt ?? null,
          input.boundarySource
        ]
      );
      const row =
        inserted.rows[0] ??
        (
          await client.query(`SELECT * FROM ingestion_gap_repairs WHERE repair_id = $1`, [
            input.repairId
          ])
        ).rows[0];
      if (!row) throw new Error("Gap repair could not be created or recovered.");
      return rowToIngestionGapRepair(row);
    });
  }

  async stageIngestionGapRepairPage(
    input: IngestionGapRepairPageInput
  ): Promise<IngestionGapRepair> {
    return this.withTransaction(async (client) => {
      const locked = await client.query(
        `SELECT * FROM ingestion_gap_repairs WHERE repair_id = $1 FOR UPDATE`,
        [input.repairId]
      );
      if (!locked.rows[0] || locked.rows[0].status !== "collecting") {
        throw new Error("Gap repair is not collecting signatures.");
      }
      if (input.signatures.length > 0) {
        await client.query(
          `INSERT INTO ingestion_gap_repair_signatures (
             repair_id, signature, slot, position_from_head
           )
           SELECT $1, item.signature, item.slot, item.position_from_head
           FROM jsonb_to_recordset($2::jsonb) AS item(
             signature TEXT, slot BIGINT, position_from_head INTEGER
           )
           ON CONFLICT (repair_id, signature) DO NOTHING`,
          [
            input.repairId,
            JSON.stringify(
              input.signatures.map((item) => ({
                signature: item.signature,
                slot: item.slot,
                position_from_head: item.positionFromHead
              }))
            )
          ]
        );
      }
      const updated = await client.query(
        `UPDATE ingestion_gap_repairs AS repair
         SET target_signature = COALESCE(repair.target_signature, $2),
             target_slot = COALESCE(repair.target_slot, $3),
             before_signature = COALESCE($4, repair.before_signature),
             status = CASE WHEN $5::boolean THEN 'replaying' ELSE 'collecting' END,
             boundary_reached = $5,
             fetched_signature_count = (
               SELECT COUNT(*)::integer
               FROM ingestion_gap_repair_signatures staged
               WHERE staged.repair_id = repair.repair_id
             ),
             collection_attempt_count = repair.collection_attempt_count + 1,
             last_error = NULL,
             updated_at = NOW()
         WHERE repair.repair_id = $1
         RETURNING repair.*`,
        [
          input.repairId,
          input.targetSignature ?? null,
          input.targetSlot ?? null,
          input.beforeSignature ?? null,
          input.boundaryReached
        ]
      );
      return rowToIngestionGapRepair(updated.rows[0]);
    });
  }

  async listPendingIngestionGapRepairSignatures(
    repairId: string,
    limit: number
  ): Promise<IngestionGapRepairSignature[]> {
    const result = await this.pool.query(
      `SELECT repair_id, signature, slot, position_from_head
       FROM ingestion_gap_repair_signatures
       WHERE repair_id = $1 AND status = 'pending'
       ORDER BY position_from_head DESC
       LIMIT $2`,
      [repairId, clampLimit(limit, 50, 200)]
    );
    return result.rows.map((row) => ({
      repairId: String(row.repair_id),
      signature: String(row.signature),
      slot: Number(row.slot),
      positionFromHead: Number(row.position_from_head)
    }));
  }

  async completeIngestionGapRepairSignature(
    repairId: string,
    signature: string,
    completedAt = new Date().toISOString()
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const completed = await client.query(
        `UPDATE ingestion_gap_repair_signatures
         SET status = 'completed', completed_at = $3
         WHERE repair_id = $1 AND signature = $2 AND status = 'pending'
         RETURNING signature`,
        [repairId, signature, completedAt]
      );
      if ((completed.rowCount ?? 0) === 0) return false;
      await client.query(
        `UPDATE ingestion_gap_repairs
         SET completed_signature_count = completed_signature_count + 1,
             replay_attempt_count = replay_attempt_count + 1,
             last_error = NULL,
             updated_at = $2
         WHERE repair_id = $1 AND status = 'replaying'`,
        [repairId, completedAt]
      );
      return true;
    });
  }

  async recordIngestionGapRepairError(
    repairId: string,
    phase: "collection" | "replay",
    error: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ingestion_gap_repairs
       SET collection_attempt_count = collection_attempt_count +
             CASE WHEN $2 = 'collection' THEN 1 ELSE 0 END,
           replay_attempt_count = replay_attempt_count +
             CASE WHEN $2 = 'replay' THEN 1 ELSE 0 END,
           status = CASE
             WHEN $3 LIKE 'gap-repair-signature-cap-%' THEN 'failed'
             ELSE status
           END,
           last_error = $3,
           updated_at = NOW()
       WHERE repair_id = $1 AND status <> 'completed'`,
      [repairId, phase, error.slice(0, 500)]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async completeIngestionGapRepair(
    repairId: string,
    coveredThrough: { signature: string; slot: number; completedAt?: string }
  ): Promise<boolean> {
    const completedAt = coveredThrough.completedAt ?? new Date().toISOString();
    const result = await this.pool.query(
      `UPDATE ingestion_gap_repairs repair
       SET status = 'completed',
           covered_through_signature = $2,
           covered_through_slot = $3,
           completed_at = $4,
           updated_at = $4,
           last_error = NULL
       WHERE repair.repair_id = $1
          AND repair.status = 'replaying'
          AND repair.boundary_reached
          AND repair.boundary_source = 'truncation_cursor'
          AND repair.target_signature = $2
          AND repair.target_slot = $3
          AND repair.completed_signature_count = repair.fetched_signature_count
          AND NOT EXISTS (
           SELECT 1
           FROM ingestion_gap_repair_signatures staged
           WHERE staged.repair_id = repair.repair_id AND staged.status = 'pending'
         )`,
      [repairId, coveredThrough.signature, coveredThrough.slot, completedAt]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async verifyIngestionGapRepairTarget(
    repairId: string,
    proof: {
      signature: string;
      slot: number;
      confirmationStatus: "finalized";
      verifiedAt?: string;
    }
  ): Promise<boolean> {
    const verifiedAt = proof.verifiedAt ?? new Date().toISOString();
    return this.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO ingestion_gap_repair_target_proofs (
           repair_id, incident_id, target_signature, target_slot,
           confirmation_status, verified_at,
           previous_covered_through_signature, previous_covered_through_slot
         )
         SELECT repair.repair_id, repair.incident_id, repair.target_signature,
                repair.target_slot, $4, $5,
                repair.covered_through_signature, repair.covered_through_slot
         FROM ingestion_gap_repairs repair
         WHERE repair.repair_id = $1
           AND repair.status = 'completed'
           AND repair.boundary_source = 'truncation_cursor'
           AND repair.target_signature = $2
           AND repair.target_slot = $3
           AND repair.completed_signature_count = repair.fetched_signature_count
           AND $4 = 'finalized'
           AND NOT EXISTS (
             SELECT 1
             FROM ingestion_gap_repair_signatures staged
             WHERE staged.repair_id = repair.repair_id
               AND staged.status <> 'completed'
           )
           AND EXISTS (
             SELECT 1
             FROM ingestion_gap_repair_signatures target
             WHERE target.repair_id = repair.repair_id
               AND target.signature = repair.target_signature
               AND target.slot = repair.target_slot
               AND target.position_from_head = 0
               AND target.status = 'completed'
           )
         ON CONFLICT (repair_id) DO NOTHING`,
        [repairId, proof.signature, proof.slot, proof.confirmationStatus, verifiedAt]
      );
      const normalized = await client.query(
        `UPDATE ingestion_gap_repairs repair
         SET covered_through_signature = repair.target_signature,
             covered_through_slot = repair.target_slot,
             updated_at = GREATEST(repair.updated_at, $4::timestamptz)
         FROM ingestion_gap_repair_target_proofs target_proof
         WHERE repair.repair_id = $1
           AND target_proof.repair_id = repair.repair_id
           AND target_proof.target_signature = $2
           AND target_proof.target_slot = $3
           AND target_proof.confirmation_status = 'finalized'
           AND repair.target_signature = target_proof.target_signature
           AND repair.target_slot = target_proof.target_slot
         RETURNING repair.repair_id`,
        [repairId, proof.signature, proof.slot, verifiedAt]
      );
      return (normalized.rowCount ?? 0) === 1;
    });
  }

  async getPipelineHealth(): Promise<PipelineHealthSummary> {
    const [summaryResult, watermarksResult] = await Promise.all([
      this.pool.query(
        `WITH unresolved AS (
          SELECT
            COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
            COUNT(*) FILTER (WHERE status = 'processing')::integer AS processing,
            COUNT(*) FILTER (WHERE status = 'retry')::integer AS retry,
            MIN(received_at) AS oldest_pending_at
          FROM chain_event_inbox
          WHERE status IN ('pending', 'processing', 'retry')
        ), dead AS (
          SELECT COUNT(*)::integer AS dead_letter
          FROM chain_event_inbox
          WHERE status = 'dead_letter'
        ), relation_estimate AS (
          SELECT GREATEST(reltuples, 0)::bigint AS total
          FROM pg_class
          WHERE oid = 'chain_event_inbox'::regclass
        ), latest_received AS (
          SELECT (
            SELECT slot FROM chain_event_inbox
            WHERE chain = 'solana' AND slot IS NOT NULL
            ORDER BY slot DESC LIMIT 1
          ) AS latest_received_slot
        ), latest_processed AS (
          SELECT (
            SELECT slot FROM chain_event_inbox
            WHERE status = 'processed' AND slot IS NOT NULL
            ORDER BY slot DESC LIMIT 1
          ) AS latest_processed_slot
        ), latest_events AS (
          SELECT
            (SELECT occurred_at FROM chain_event_inbox
             WHERE event_type = 'pool_created'
             ORDER BY occurred_at DESC LIMIT 1) AS last_pool_at,
            (SELECT occurred_at FROM chain_event_inbox
             WHERE event_type = 'swap'
             ORDER BY occurred_at DESC LIMIT 1) AS last_swap_at
        ), attempts AS (
          SELECT
            COUNT(*) FILTER (WHERE status = 'succeeded')::integer AS succeeded,
            COUNT(*) FILTER (WHERE status IN ('succeeded', 'retry', 'dead_letter'))::integer AS finished
          FROM event_processing_attempts
          WHERE started_at >= NOW() - INTERVAL '24 hours'
        ), trades AS (
          SELECT
            MAX(observed_at) AS last_wallet_trade_at,
            COUNT(*)::integer AS total,
            COUNT(*) FILTER (
              WHERE execution_price_usd IS NOT NULL
                AND data_quality IN ('observed-execution', 'oracle-converted')
            )::integer AS high_quality
          FROM wallet_trade_events
          WHERE observed_at >= NOW() - INTERVAL '24 hours'
        )
        SELECT
          unresolved.*,
          dead.dead_letter,
          GREATEST(
            relation_estimate.total - unresolved.pending - unresolved.processing -
            unresolved.retry - dead.dead_letter,
            0
          )::integer AS processed,
          0::integer AS rolled_back,
          latest_received.latest_received_slot,
          latest_processed.latest_processed_slot,
          latest_events.last_pool_at,
          latest_events.last_swap_at,
          attempts.*,
          trades.*
        FROM unresolved, dead, relation_estimate, latest_received, latest_processed,
             latest_events, attempts, trades`
      ),
      this.pool.query(
        `SELECT *, COUNT(*) OVER()::integer AS total_count
         FROM pipeline_watermarks
         ORDER BY updated_at DESC, pipeline, partition_key
         LIMIT 25`
      )
    ]);
    const row = summaryResult.rows[0] ?? {};
    const latestReceivedSlot = nullableNumber(row.latest_received_slot);
    const latestProcessedSlot = nullableNumber(row.latest_processed_slot);
    const totalTrades = Number(row.total ?? 0);
    const finished = Number(row.finished ?? 0);
    const succeeded = Number(row.succeeded ?? 0);
    const oldestPendingAt = row.oldest_pending_at
      ? new Date(String(row.oldest_pending_at)).getTime()
      : undefined;
    return {
      database: "ok",
      checkedAt: new Date().toISOString(),
      processedCountEstimated: true,
      inbox: {
        pending: Number(row.pending ?? 0),
        processing: Number(row.processing ?? 0),
        retry: Number(row.retry ?? 0),
        processed: Number(row.processed ?? 0),
        dead_letter: Number(row.dead_letter ?? 0),
        rolled_back: Number(row.rolled_back ?? 0)
      },
      backlog: Number(row.pending ?? 0) + Number(row.processing ?? 0) + Number(row.retry ?? 0),
      deadLetterCount: Number(row.dead_letter ?? 0),
      parserSuccessRate: finished === 0 ? 1 : succeeded / finished,
      ...(latestReceivedSlot !== undefined ? { latestReceivedSlot } : {}),
      ...(latestProcessedSlot !== undefined ? { latestProcessedSlot } : {}),
      ...(latestReceivedSlot !== undefined && latestProcessedSlot !== undefined
        ? { processingLagSlots: Math.max(0, latestReceivedSlot - latestProcessedSlot) }
        : {}),
      ...(oldestPendingAt !== undefined
        ? { oldestPendingAgeSeconds: Math.max(0, (Date.now() - oldestPendingAt) / 1_000) }
        : {}),
      ...(row.last_pool_at ? { lastPoolAt: new Date(String(row.last_pool_at)).toISOString() } : {}),
      ...(row.last_swap_at ? { lastSwapAt: new Date(String(row.last_swap_at)).toISOString() } : {}),
      ...(row.last_wallet_trade_at
        ? { lastWalletTradeAt: new Date(String(row.last_wallet_trade_at)).toISOString() }
        : {}),
      highQualityPriceCoverage: totalTrades === 0 ? 0 : Number(row.high_quality ?? 0) / totalTrades,
      watermarkCount: Number(watermarksResult.rows[0]?.total_count ?? 0),
      watermarks: watermarksResult.rows.map((watermark) => rowToPipelineWatermark(watermark))
    };
  }

  async listWalletAlphaRankings(
    options: WalletAlphaRankingQuery = {}
  ): Promise<WalletAlphaScoreSnapshot[]> {
    if (options.strategyVersion && options.statuses?.length) {
      const result = await this.pool.query(
        `SELECT score.*
         FROM wallet_alpha_scores AS score
         WHERE score.strategy_version = $1
           AND score.status = ANY($2::text[])
           AND NOT EXISTS (
             SELECT 1
             FROM wallet_alpha_scores AS newer
             WHERE newer.strategy_version = score.strategy_version
               AND newer.chain = score.chain
               AND newer.wallet_address = score.wallet_address
               AND newer.calculated_at > score.calculated_at
           )
         ORDER BY score.overall_score DESC, score.calculated_at DESC
         LIMIT $3 OFFSET $4`,
        [
          options.strategyVersion,
          options.statuses,
          clampLimit(options.limit, 100, 500),
          Math.max(0, Math.trunc(options.offset ?? 0))
        ]
      );
      return result.rows.map((row) => rowToWalletAlphaScore(row));
    }

    const params: unknown[] = [];
    let where = "WHERE 1=1";
    if (options.strategyVersion) {
      params.push(options.strategyVersion);
      where += ` AND strategy_version = $${params.length}`;
    }
    params.push(options.statuses?.length ? options.statuses : null);
    const statusesParam = params.length;
    params.push(clampLimit(options.limit, 100, 500));
    const limitParam = params.length;
    params.push(Math.max(0, Math.trunc(options.offset ?? 0)));
    const offsetParam = params.length;
    const result = await this.pool.query(
      `WITH latest AS (
        SELECT DISTINCT ON (chain, wallet_address, strategy_version) *
        FROM wallet_alpha_scores
        ${where}
        ORDER BY chain, wallet_address, strategy_version, calculated_at DESC
      )
      SELECT * FROM latest
      WHERE ($${statusesParam}::text[] IS NULL OR status = ANY($${statusesParam}::text[]))
      ORDER BY overall_score DESC, calculated_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params
    );
    return result.rows.map((row) => rowToWalletAlphaScore(row));
  }

  async getWalletAlphaDetail(
    walletAddress: string,
    strategyVersion?: string
  ): Promise<WalletAlphaDetail | undefined> {
    const scoreResult = await this.pool.query(
      `SELECT * FROM wallet_alpha_scores
       WHERE wallet_address = $1
         AND ($2::text IS NULL OR strategy_version = $2)
       ORDER BY calculated_at DESC
       LIMIT 90`,
      [walletAddress, strategyVersion ?? null]
    );
    const scores = scoreResult.rows.map((row) => rowToWalletAlphaScore(row));
    const latestScore = scores[0];
    if (!latestScore) return undefined;
    const selectedVersion = strategyVersion ?? latestScore.strategyVersion;
    const [tradeResult, episodeResult, lotResult] = await Promise.all([
      this.pool.query(
        `SELECT * FROM wallet_trade_events
         WHERE wallet_address = $1 AND strategy_version = $2
         ORDER BY observed_at DESC LIMIT 100`,
        [walletAddress, selectedVersion]
      ),
      this.pool.query(
        `SELECT * FROM wallet_position_episodes
         WHERE wallet_address = $1 AND strategy_version = $2
         ORDER BY opened_at DESC LIMIT 100`,
        [walletAddress, selectedVersion]
      ),
      this.pool.query(
        `SELECT lot.*
         FROM wallet_position_lots AS lot
         INNER JOIN wallet_position_episodes AS episode ON episode.id = lot.episode_id
         WHERE episode.wallet_address = $1 AND episode.strategy_version = $2
         ORDER BY episode.opened_at DESC, lot.lot_sequence ASC
         LIMIT 500`,
        [walletAddress, selectedVersion]
      )
    ]);
    return {
      walletAddress,
      latestScore,
      scoreHistory: scores.filter((score) => score.strategyVersion === selectedVersion),
      recentTrades: tradeResult.rows.map((row) => rowToWalletTradeEvent(row)),
      episodes: episodeResult.rows.map((row) => rowToWalletPositionEpisode(row)),
      lots: lotResult.rows.map((row) => rowToWalletPositionLot(row))
    };
  }

  async listWalletAlphaSignalFeed(
    options: WalletAlphaSignalQuery = {}
  ): Promise<WalletAlphaSignalEvidence[]> {
    const result = await this.pool.query(
      `SELECT * FROM wallet_alpha_signals
       WHERE ($1::text IS NULL OR strategy_version = $1)
         AND ($2::text[] IS NULL OR status = ANY($2::text[]))
       ORDER BY detected_at DESC
       LIMIT $3 OFFSET $4`,
      [
        options.strategyVersion ?? null,
        options.statuses?.length ? options.statuses : null,
        clampLimit(options.limit, 100, 500),
        Math.max(0, Math.trunc(options.offset ?? 0))
      ]
    );
    return result.rows.map((row) => rowToWalletAlphaSignal(row));
  }

  async claimSignalOutbox(options: SignalOutboxClaimOptions): Promise<SignalOutboxMessage[]> {
    const result = await this.pool.query(
      `WITH candidates AS (
        SELECT id
        FROM signal_outbox
        WHERE destination = $1
          AND (
            (status IN ('pending', 'retry') AND available_at <= NOW())
            OR (status = 'processing' AND lock_expires_at <= NOW())
          )
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      )
      UPDATE signal_outbox AS message
      SET status = 'processing',
          attempt_count = message.attempt_count + 1,
          locked_by = $3,
          locked_at = NOW(),
          lock_expires_at = NOW() + ($4 * INTERVAL '1 second'),
          last_error = NULL
      FROM candidates
      WHERE message.id = candidates.id
      RETURNING message.*`,
      [
        options.destination,
        clampLimit(options.limit, 100, 500),
        options.workerId,
        Math.max(1, Math.trunc(options.leaseSeconds ?? 30))
      ]
    );
    return result.rows.map((row) => rowToSignalOutboxMessage(row));
  }

  async completeSignalOutbox(
    id: string,
    workerId: string,
    deliveredAt = new Date().toISOString()
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE signal_outbox
       SET status = 'delivered', delivered_at = $3,
           locked_by = NULL, locked_at = NULL, lock_expires_at = NULL, last_error = NULL
       WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
      [id, workerId, deliveredAt]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async failSignalOutbox(
    id: string,
    workerId: string,
    error: string,
    options: SignalOutboxFailureOptions = {}
  ): Promise<SignalOutboxMessage | undefined> {
    const result = await this.pool.query(
      `UPDATE signal_outbox
       SET status = CASE WHEN attempt_count >= $4 THEN 'dead_letter' ELSE 'retry' END,
           available_at = $5,
           locked_by = NULL,
           locked_at = NULL,
           lock_expires_at = NULL,
           last_error = $3
       WHERE id = $1 AND status = 'processing' AND locked_by = $2
       RETURNING *`,
      [
        id,
        workerId,
        error,
        Math.max(1, Math.trunc(options.maxAttempts ?? 5)),
        options.retryAt ?? new Date(Date.now() + 5_000).toISOString()
      ]
    );
    const row = result.rows[0];
    return row ? rowToSignalOutboxMessage(row) : undefined;
  }
}

function rowToToken(row: Record<string, unknown>): TokenSnapshot {
  return {
    chain: row.chain as ChainId,
    address: String(row.address),
    symbol: String(row.symbol ?? ""),
    name: String(row.name ?? ""),
    ...(row.decimals !== null ? { decimals: Number(row.decimals) } : {}),
    ...(row.creator_address ? { creatorAddress: String(row.creator_address) } : {}),
    firstSeenAt: new Date(String(row.first_seen_at)).toISOString(),
    metadata: (row.metadata as Record<string, unknown>) ?? {}
  };
}

function rowToHistoricalBackfillWindow(row: Record<string, unknown>): HistoricalBackfillWindow {
  return {
    runId: String(row.run_id),
    stage: row.stage as HistoricalBackfillWindow["stage"],
    address: String(row.address),
    windowStartUnix: Number(row.window_start_unix),
    windowEndUnix: Number(row.window_end_unix),
    status: row.status as HistoricalBackfillWindow["status"],
    pagesFetched: Number(row.pages_fetched),
    transactionsFetched: Number(row.transactions_fetched),
    ...(row.last_signature ? { lastSignature: String(row.last_signature) } : {}),
    ...(row.last_slot !== null ? { lastSlot: Number(row.last_slot) } : {}),
    provider: String(row.provider),
    strategyVersion: String(row.strategy_version),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    raw: (row.raw as Record<string, unknown>) ?? {}
  };
}

function rowToPool(row: Record<string, unknown>): PoolSnapshot {
  const raw = (row.raw as Record<string, unknown>) ?? {};
  const baseToken = raw.baseToken as Record<string, unknown> | undefined;
  const volume = raw.volume as Record<string, unknown> | undefined;
  const txns = raw.txns as Record<string, { buys?: number; sells?: number }> | undefined;
  const m5 = txns?.m5;
  return {
    chain: row.chain as ChainId,
    poolAddress: String(row.pool_address),
    dex: String(row.dex),
    baseTokenAddress: String(row.base_token_address),
    ...(row.quote_token_address ? { quoteTokenAddress: String(row.quote_token_address) } : {}),
    ...(row.created_at ? { createdAt: new Date(String(row.created_at)).toISOString() } : {}),
    liquidityUsd: Number(row.liquidity_usd ?? 0),
    ...((row.token_symbol ?? baseToken?.symbol)
      ? { tokenSymbol: String(row.token_symbol ?? baseToken?.symbol) }
      : {}),
    ...((row.token_name ?? baseToken?.name)
      ? { tokenName: String(row.token_name ?? baseToken?.name) }
      : {}),
    ...((row.price_usd ?? raw.priceUsd) ? { priceUsd: Number(row.price_usd ?? raw.priceUsd) } : {}),
    ...((row.market_cap_usd ?? raw.marketCap ?? raw.fdv)
      ? { marketCapUsd: Number(row.market_cap_usd ?? raw.marketCap ?? raw.fdv) }
      : {}),
    volume5mUsd: Number(row.volume_5m_usd ?? raw.volume5mUsd ?? volume?.m5 ?? 0),
    volume1hUsd: Number(raw.volume1hUsd ?? volume?.h1 ?? 0),
    txns5m: {
      buys: Number(raw.buys5m ?? m5?.buys ?? 0),
      sells: Number(raw.sells5m ?? m5?.sells ?? 0)
    },
    raw
  };
}

function rowToPaperTrade(row: Record<string, unknown>): PaperTrade {
  return {
    id: String(row.id),
    signalId: String(row.signal_id),
    strategyVersion: String(row.strategy_version),
    chain: row.chain as PaperTrade["chain"],
    tokenAddress: String(row.token_address),
    side: row.side as PaperTrade["side"],
    status: row.status as PaperTrade["status"],
    quantity: Number(row.quantity),
    priceUsd: Number(row.price_usd),
    notionalUsd: Number(row.notional_usd),
    feesUsd: Number(row.fees_usd),
    slippageBps: Number(row.slippage_bps),
    openedAt: new Date(String(row.opened_at)).toISOString(),
    ...(row.closed_at ? { closedAt: new Date(String(row.closed_at)).toISOString() } : {}),
    ...(row.pnl_usd !== null ? { pnlUsd: Number(row.pnl_usd) } : {}),
    reason: String(row.reason ?? ""),
    raw: (row.raw ?? {}) as Record<string, unknown>
  };
}

function rowToWalletScore(row: Record<string, unknown>): WalletScore {
  return {
    chain: row.chain as ChainId,
    walletAddress: String(row.wallet_address),
    score: Number(row.score),
    category: row.category as WalletScore["category"],
    calculatedAt: new Date(String(row.calculated_at)).toISOString(),
    reasons: row.reasons as string[],
    features: row.features as WalletScore["features"]
  };
}

function evidenceMetadata(row: Record<string, unknown>) {
  return {
    idempotencyKey: String(row.idempotency_key),
    chain: row.chain as ChainId,
    signature: String(row.signature),
    slot: Number(row.slot),
    provider: String(row.provider),
    observedAt: new Date(String(row.observed_at)).toISOString(),
    strategyVersion: String(row.strategy_version)
  };
}

function rowToPriceObservation(row: Record<string, unknown>): PriceObservationEvidence {
  return {
    ...evidenceMetadata(row),
    tokenAddress: String(row.token_address),
    ...(row.pool_address ? { poolAddress: String(row.pool_address) } : {}),
    priceUsd: Number(row.price_usd),
    liquidityUsd: Number(row.liquidity_usd),
    rugged: Boolean(row.rugged),
    raw: (row.raw as Record<string, unknown>) ?? {}
  };
}

function rowToOnchainSwap(row: Record<string, unknown>): OnchainSwapEvidence {
  return {
    ...evidenceMetadata(row),
    poolAddress: String(row.pool_address),
    traderAddress: String(row.trader_address),
    inputTokenAddress: String(row.input_token_address),
    outputTokenAddress: String(row.output_token_address),
    ...(row.input_amount !== null ? { inputAmount: Number(row.input_amount) } : {}),
    ...(row.output_amount !== null ? { outputAmount: Number(row.output_amount) } : {}),
    ...(row.price_usd !== null ? { priceUsd: Number(row.price_usd) } : {}),
    ...(row.volume_usd !== null ? { volumeUsd: Number(row.volume_usd) } : {}),
    raw: (row.raw as Record<string, unknown>) ?? {}
  };
}

function rowToWalletEntrySignal(row: Record<string, unknown>): WalletEntrySignalEvidence {
  return {
    ...evidenceMetadata(row),
    walletAddress: String(row.wallet_address),
    tokenAddress: String(row.token_address),
    ...(row.pool_address ? { poolAddress: String(row.pool_address) } : {}),
    ...(row.source_swap_idempotency_key
      ? { sourceSwapIdempotencyKey: String(row.source_swap_idempotency_key) }
      : {}),
    observedEntryPriceUsd: Number(row.observed_entry_price_usd),
    observedLiquidityUsd: Number(row.observed_liquidity_usd),
    cohort: String(row.cohort),
    repeatWalletCount: Number(row.repeat_wallet_count),
    flowEvidence: (row.flow_evidence as Record<string, unknown>) ?? {}
  };
}

function rowToWalletTradeEvent(row: Record<string, unknown>): WalletTradeEvidence {
  return {
    ...evidenceMetadata(row),
    walletAddress: String(row.wallet_address),
    tokenAddress: String(row.token_address),
    ...(row.quote_token_address ? { quoteTokenAddress: String(row.quote_token_address) } : {}),
    ...(row.pool_address ? { poolAddress: String(row.pool_address) } : {}),
    side: row.side as WalletTradeEvidence["side"],
    baseAmount: Number(row.base_amount),
    ...(row.quote_amount !== null ? { quoteAmount: Number(row.quote_amount) } : {}),
    ...(row.execution_price_usd !== null
      ? { executionPriceUsd: Number(row.execution_price_usd) }
      : {}),
    ...(row.quote_value_usd !== null ? { quoteValueUsd: Number(row.quote_value_usd) } : {}),
    ...(row.pool_created_at
      ? { poolCreatedAt: new Date(String(row.pool_created_at)).toISOString() }
      : {}),
    ...(row.pool_age_minutes !== null ? { poolAgeMinutes: Number(row.pool_age_minutes) } : {}),
    dataQuality: row.data_quality as WalletTradeEvidence["dataQuality"],
    raw: (row.raw as Record<string, unknown>) ?? {}
  };
}

function rowToWalletAlphaScore(row: Record<string, unknown>): WalletAlphaScoreSnapshot {
  return {
    chain: row.chain as WalletAlphaScoreSnapshot["chain"],
    walletAddress: String(row.wallet_address),
    strategyVersion: String(row.strategy_version),
    calculatedAt: new Date(String(row.calculated_at)).toISOString(),
    status: row.status as WalletAlphaScoreSnapshot["status"],
    profitabilityScore: Number(row.profitability_score),
    followabilityScore: Number(row.followability_score),
    overallScore: Number(row.overall_score),
    completedPositions: Number(row.completed_positions),
    uniqueTokens: Number(row.unique_tokens),
    activeDays: Number(row.active_days),
    metrics: row.metrics as WalletAlphaScoreSnapshot["metrics"],
    gates: row.gates as WalletAlphaScoreSnapshot["gates"],
    reasons: row.reasons as string[]
  };
}

function rowToWalletAlphaSignal(row: Record<string, unknown>): WalletAlphaSignalEvidence {
  return {
    id: String(row.id),
    chain: row.chain as WalletAlphaSignalEvidence["chain"],
    tokenAddress: String(row.token_address),
    ...(row.pool_address ? { poolAddress: String(row.pool_address) } : {}),
    strategyVersion: String(row.strategy_version),
    detectedAt: new Date(String(row.detected_at)).toISOString(),
    observedPriceUsd: Number(row.observed_price_usd),
    observedLiquidityUsd: Number(row.observed_liquidity_usd),
    confidence: Number(row.confidence),
    status: row.status as WalletAlphaSignalEvidence["status"],
    walletAddresses: row.wallet_addresses as string[],
    evidence: (row.evidence as Record<string, unknown>) ?? {}
  };
}

function rowToWalletSignalOutcome(row: Record<string, unknown>): WalletSignalOutcomeEvidence {
  return {
    ...evidenceMetadata(row),
    entryIdempotencyKey: String(row.entry_idempotency_key),
    horizonMinutes: Number(row.horizon_minutes),
    status: row.status as WalletSignalOutcomeEvidence["status"],
    ...(row.outcome_price_usd !== null ? { outcomePriceUsd: Number(row.outcome_price_usd) } : {}),
    ...(row.frozen_at ? { frozenAt: new Date(String(row.frozen_at)).toISOString() } : {}),
    ...(row.gross_return_pct !== null ? { grossReturnPct: Number(row.gross_return_pct) } : {}),
    ...(row.net_return_pct !== null ? { netReturnPct: Number(row.net_return_pct) } : {}),
    estimatedRoundTripCostPct: Number(row.estimated_round_trip_cost_pct),
    exitStrategy: row.exit_strategy as WalletSignalOutcomeEvidence["exitStrategy"],
    rugged: Boolean(row.rugged),
    raw: (row.raw as Record<string, unknown>) ?? {}
  };
}

function rowToHypothesisRun(row: Record<string, unknown>): HypothesisRunEvidence {
  return {
    ...evidenceMetadata(row),
    runId: String(row.run_id),
    hypothesisKey: String(row.hypothesis_key),
    cohort: String(row.cohort),
    verdict: row.verdict as HypothesisRunEvidence["verdict"],
    signalKeys: row.signal_keys as string[],
    metrics: row.metrics as HypothesisRunEvidence["metrics"],
    decisionReason: String(row.decision_reason)
  };
}

function rowToIngestionCursor(row: Record<string, unknown>): IngestionCursorEvidence {
  return {
    ...evidenceMetadata(row),
    source: String(row.source),
    address: String(row.address),
    lastSignature: String(row.last_signature),
    lastSlot: Number(row.last_slot),
    ...(row.last_event_occurred_at
      ? { lastEventOccurredAt: new Date(String(row.last_event_occurred_at)).toISOString() }
      : {})
  };
}

function rowToCanonicalChainEvent(row: Record<string, unknown>): CanonicalChainEvent {
  return {
    idempotencyKey: String(row.idempotency_key),
    chain: row.chain as CanonicalChainEvent["chain"],
    ...(row.signature ? { signature: String(row.signature) } : {}),
    ...(row.slot !== null ? { slot: Number(row.slot) } : {}),
    ...(row.transaction_index !== null ? { transactionIndex: Number(row.transaction_index) } : {}),
    ...(row.instruction_index !== null ? { instructionIndex: Number(row.instruction_index) } : {}),
    ...(row.inner_instruction_index !== null
      ? { innerInstructionIndex: Number(row.inner_instruction_index) }
      : {}),
    eventType: String(row.event_type),
    ...(row.token_address ? { tokenAddress: String(row.token_address) } : {}),
    ...(row.pool_address ? { poolAddress: String(row.pool_address) } : {}),
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
    receivedAt: new Date(String(row.received_at)).toISOString(),
    commitment: row.commitment as CanonicalChainEvent["commitment"],
    requiresFinality: Boolean(row.finality_required),
    source: String(row.source),
    decoderVersion: String(row.decoder_version),
    payload: (row.payload as Record<string, unknown>) ?? {},
    status: row.status as CanonicalChainEvent["status"],
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: new Date(String(row.next_attempt_at)).toISOString(),
    ...(row.processed_at ? { processedAt: new Date(String(row.processed_at)).toISOString() } : {}),
    ...(row.finalized_at ? { finalizedAt: new Date(String(row.finalized_at)).toISOString() } : {}),
    ...(row.locked_by ? { lockedBy: String(row.locked_by) } : {}),
    ...(row.locked_at ? { lockedAt: new Date(String(row.locked_at)).toISOString() } : {}),
    ...(row.lock_expires_at
      ? { lockExpiresAt: new Date(String(row.lock_expires_at)).toISOString() }
      : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {})
  };
}

function rowToPipelineWatermark(row: Record<string, unknown>): PipelineWatermark {
  return {
    pipeline: String(row.pipeline),
    partitionKey: String(row.partition_key),
    chain: row.chain as PipelineWatermark["chain"],
    lastContiguousSlot: Number(row.last_contiguous_slot),
    ...(row.last_signature ? { lastSignature: String(row.last_signature) } : {}),
    status: row.status as PipelineWatermark["status"],
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    metadata: (row.metadata as Record<string, unknown>) ?? {}
  };
}

function rowToIngestionCoverageIncident(row: Record<string, unknown>): IngestionCoverageIncident {
  return {
    idempotencyKey: String(row.idempotency_key),
    chain: "solana",
    provider: String(row.provider),
    programAddress: String(row.program_address),
    reason: String(row.reason) as IngestionCoverageIncident["reason"],
    gapStartedAt: new Date(String(row.gap_started_at)).toISOString(),
    openedAt: new Date(String(row.opened_at)).toISOString(),
    ...(row.cluster_slot !== null ? { clusterSlot: Number(row.cluster_slot) } : {}),
    ...(row.source_slot !== null ? { sourceSlot: Number(row.source_slot) } : {}),
    ...(row.slot_lag !== null ? { slotLag: Number(row.slot_lag) } : {}),
    ...(row.last_websocket_message_at !== null
      ? { lastWebsocketMessageAt: new Date(String(row.last_websocket_message_at)).toISOString() }
      : {}),
    ...(row.silence_ms !== null ? { silenceMs: Number(row.silence_ms) } : {}),
    subscriptionAckTimeoutCount: Number(row.subscription_ack_timeout_count),
    successfulSubscriptionAckCount: Number(row.successful_subscription_ack_count),
    metadata: (row.open_metadata ?? {}) as Record<string, unknown>,
    ...(row.restart_attempted_at !== null
      ? { restartAttemptedAt: new Date(String(row.restart_attempted_at)).toISOString() }
      : {}),
    ...(row.restart_completed_at !== null
      ? { restartCompletedAt: new Date(String(row.restart_completed_at)).toISOString() }
      : {}),
    restartAttemptCount: Number(row.restart_attempt_count ?? 0),
    ...(row.last_restart_attempted_at !== null
      ? { lastRestartAttemptedAt: new Date(String(row.last_restart_attempted_at)).toISOString() }
      : {}),
    ...(row.last_restart_completed_at !== null
      ? { lastRestartCompletedAt: new Date(String(row.last_restart_completed_at)).toISOString() }
      : {}),
    ...(row.last_restart_error !== null
      ? { lastRestartError: String(row.last_restart_error) }
      : {}),
    ...(row.closed_at !== null ? { closedAt: new Date(String(row.closed_at)).toISOString() } : {}),
    ...(row.close_cluster_slot !== null
      ? { closeClusterSlot: Number(row.close_cluster_slot) }
      : {}),
    ...(row.close_source_slot !== null ? { closeSourceSlot: Number(row.close_source_slot) } : {}),
    ...(row.resolution !== null
      ? {
          resolution: String(row.resolution) as "transport_recovered_gap_unreconciled"
        }
      : {}),
    ...(row.close_metadata !== null
      ? { closeMetadata: row.close_metadata as Record<string, unknown> }
      : {}),
    ...(row.coverage_reconciled_at !== null && row.coverage_reconciled_at !== undefined
      ? {
          coverageReconciledAt: new Date(String(row.coverage_reconciled_at)).toISOString()
        }
      : {}),
    ...(row.coverage_repair_id !== null && row.coverage_repair_id !== undefined
      ? { coverageRepairId: String(row.coverage_repair_id) }
      : {}),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function rowToIngestionGapRepair(row: Record<string, unknown>): IngestionGapRepair {
  return {
    repairId: String(row.repair_id),
    incidentId: String(row.incident_id),
    provider: String(row.provider),
    programAddress: String(row.program_address),
    cursorSignature: String(row.cursor_signature),
    cursorSlot: Number(row.cursor_slot),
    ...(row.cursor_occurred_at
      ? { cursorOccurredAt: new Date(String(row.cursor_occurred_at)).toISOString() }
      : {}),
    boundarySource: String(row.boundary_source) as IngestionGapRepair["boundarySource"],
    ...(row.target_signature ? { targetSignature: String(row.target_signature) } : {}),
    ...(row.target_slot !== null && row.target_slot !== undefined
      ? { targetSlot: Number(row.target_slot) }
      : {}),
    ...(row.before_signature ? { beforeSignature: String(row.before_signature) } : {}),
    status: String(row.status) as IngestionGapRepair["status"],
    boundaryReached: row.boundary_reached === true,
    fetchedSignatureCount: Number(row.fetched_signature_count ?? 0),
    completedSignatureCount: Number(row.completed_signature_count ?? 0),
    collectionAttemptCount: Number(row.collection_attempt_count ?? 0),
    replayAttemptCount: Number(row.replay_attempt_count ?? 0),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    ...(row.covered_through_signature
      ? { coveredThroughSignature: String(row.covered_through_signature) }
      : {}),
    ...(row.covered_through_slot !== null && row.covered_through_slot !== undefined
      ? { coveredThroughSlot: Number(row.covered_through_slot) }
      : {}),
    ...(row.target_verified_at
      ? { targetVerifiedAt: new Date(String(row.target_verified_at)).toISOString() }
      : {}),
    ...(row.target_verified_slot !== null && row.target_verified_slot !== undefined
      ? { targetVerifiedSlot: Number(row.target_verified_slot) }
      : {}),
    ...(row.target_confirmation_status
      ? { targetConfirmationStatus: String(row.target_confirmation_status) as "finalized" }
      : {}),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    ...(row.completed_at ? { completedAt: new Date(String(row.completed_at)).toISOString() } : {})
  };
}

function rowToWalletPositionEpisode(row: Record<string, unknown>): WalletPositionEpisode {
  return {
    id: String(row.id),
    chain: row.chain as WalletPositionEpisode["chain"],
    walletAddress: String(row.wallet_address),
    tokenAddress: String(row.token_address),
    strategyVersion: String(row.strategy_version),
    episodeIndex: Number(row.episode_index),
    status: row.status as WalletPositionEpisode["status"],
    openedAt: new Date(String(row.opened_at)).toISOString(),
    ...(row.closed_at ? { closedAt: new Date(String(row.closed_at)).toISOString() } : {}),
    costBasisUsd: Number(row.cost_basis_usd),
    proceedsUsd: Number(row.proceeds_usd),
    realizedPnlUsd: Number(row.realized_pnl_usd),
    ...(row.return_pct !== null ? { returnPct: Number(row.return_pct) } : {}),
    remainingRawAmount: String(row.remaining_raw_amount),
    tokenDecimals: Number(row.token_decimals),
    realizedLotCount: Number(row.realized_lot_count),
    highQualityPriceCoverage: Number(row.high_quality_price_coverage),
    ...(row.terminal_reason ? { terminalReason: String(row.terminal_reason) } : {}),
    metadata: (row.metadata as Record<string, unknown>) ?? {}
  };
}

function rowToWalletPositionLot(row: Record<string, unknown>): WalletPositionLot {
  return {
    id: String(row.id),
    episodeId: String(row.episode_id),
    sourceEventIdempotencyKey: String(row.source_event_idempotency_key),
    lotSequence: Number(row.lot_sequence),
    rawAmount: String(row.raw_amount),
    remainingRawAmount: String(row.remaining_raw_amount),
    tokenDecimals: Number(row.token_decimals),
    quoteCostUsd: Number(row.quote_cost_usd),
    feesUsd: Number(row.fees_usd),
    slippageUsd: Number(row.slippage_usd),
    openedAt: new Date(String(row.opened_at)).toISOString(),
    ...(row.closed_at ? { closedAt: new Date(String(row.closed_at)).toISOString() } : {}),
    status: row.status as WalletPositionLot["status"],
    metadata: (row.metadata as Record<string, unknown>) ?? {}
  };
}

function rowToSignalOutboxMessage(row: Record<string, unknown>): SignalOutboxMessage {
  return {
    id: String(row.id),
    signalId: String(row.signal_id),
    destination: row.destination as SignalOutboxMessage["destination"],
    eventType: "wallet-alpha-signal",
    payload: (row.payload as Record<string, unknown>) ?? {},
    status: row.status as SignalOutboxMessage["status"],
    attemptCount: Number(row.attempt_count),
    availableAt: new Date(String(row.available_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString(),
    ...(row.delivered_at ? { deliveredAt: new Date(String(row.delivered_at)).toISOString() } : {}),
    ...(row.locked_by ? { lockedBy: String(row.locked_by) } : {}),
    ...(row.locked_at ? { lockedAt: new Date(String(row.locked_at)).toISOString() } : {}),
    ...(row.lock_expires_at
      ? { lockExpiresAt: new Date(String(row.lock_expires_at)).toISOString() }
      : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {})
  };
}

function clampLimit(value: number | undefined, defaultValue: number, maximum: number): number {
  return Math.min(maximum, Math.max(1, Math.trunc(value ?? defaultValue)));
}

function assertWalletAlphaPriorityRange(
  minimumPriority: WalletAlphaWorkPriority,
  maximumPriority: WalletAlphaWorkPriority
): void {
  if (
    !Number.isInteger(minimumPriority) ||
    !Number.isInteger(maximumPriority) ||
    minimumPriority < 0 ||
    maximumPriority > 2 ||
    minimumPriority > maximumPriority
  ) {
    throw new Error("Wallet-alpha priority range must be ordered within 0..2.");
  }
}

async function boundedWalletAlphaProbe(
  client: TransactionClient,
  stage: "trade-events" | "entries" | "outcomes",
  query: string,
  params: unknown[]
): Promise<boolean> {
  try {
    const result = await client.query<{ exceeded: boolean }>(query, params);
    return Boolean(result.rows[0]?.exceeded);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Wallet-alpha ${stage} bound probe failed: ${message}`);
  }
}

function walletAlphaWorkRevisionKey(candidate: WalletAlphaWorkCandidate): string {
  return [
    candidate.chain,
    candidate.walletAddress,
    candidate.strategyVersion,
    candidate.revision
  ].join(":");
}

function nullableNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}
