import type pg from "pg";
import type { PaperTrade, QualifiedPoolNotification } from "@memecoin-alpha/shared";

export interface PaperPortfolioRecord {
  strategyVersion: string;
  startingBalanceUsd: number;
  activatedAt: string;
  status: "active" | "paused";
  config: Record<string, unknown>;
}

export interface PaperPortfolioSnapshot extends PaperPortfolioRecord {
  cashBalanceUsd: number;
  committedExposureUsd: number;
  realizedPnlUsd: number;
  openPositionCount: number;
}

export interface QualifiedPoolPaperCandidate {
  notificationId: string;
  deliveredAt: string;
  payload: QualifiedPoolNotification;
  currentRiskPassed: boolean;
}

export interface PaperTradeEvent {
  id: string;
  tradeId: string;
  strategyVersion: string;
  eventType: "opened" | "partial_exit" | "closed" | "rugged";
  quantity: number;
  priceUsd: number;
  grossValueUsd: number;
  feesUsd: number;
  cashDeltaUsd: number;
  realizedPnlUsd: number;
  slippageBps: number;
  occurredAt: string;
  reason: string;
  liquidityUsd?: number;
  raw?: Record<string, unknown>;
}

export class PaperTradingStore {
  constructor(private readonly pool: pg.Pool) {}

  async initializePortfolio(input: {
    strategyVersion: string;
    startingBalanceUsd: number;
    config: Record<string, unknown>;
    activatedAt?: string;
  }): Promise<PaperPortfolioRecord> {
    const activatedAt = input.activatedAt ?? new Date().toISOString();
    const result = await this.pool.query(
      `WITH initialized AS (
         INSERT INTO paper_portfolios (
           strategy_version, starting_balance_usd, activated_at, config
         )
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (strategy_version) DO NOTHING
         RETURNING *
       )
       SELECT * FROM initialized
       UNION ALL
       SELECT * FROM paper_portfolios
       WHERE strategy_version = $1
         AND NOT EXISTS (SELECT 1 FROM initialized)
       LIMIT 1`,
      [input.strategyVersion, input.startingBalanceUsd, activatedAt, JSON.stringify(input.config)]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Paper portfolio could not be initialized.");
    return rowToPortfolio(row);
  }

  async getPortfolioSnapshot(strategyVersion: string): Promise<PaperPortfolioSnapshot> {
    const result = await this.pool.query(
      `SELECT
         portfolio.*,
         portfolio.starting_balance_usd
           + COALESCE(SUM(event.cash_delta_usd), 0) AS cash_balance_usd,
         COALESCE(SUM(event.realized_pnl_usd), 0) AS realized_pnl_usd,
         COALESCE((
           SELECT SUM(trade.notional_usd)
           FROM paper_trades trade
           WHERE trade.strategy_version = portfolio.strategy_version
             AND trade.status = 'open'
         ), 0) AS committed_exposure_usd,
         COALESCE((
           SELECT COUNT(*)::integer
           FROM paper_trades trade
           WHERE trade.strategy_version = portfolio.strategy_version
             AND trade.status = 'open'
         ), 0) AS open_position_count
       FROM paper_portfolios portfolio
       LEFT JOIN paper_trade_events event
         ON event.strategy_version = portfolio.strategy_version
       WHERE portfolio.strategy_version = $1
       GROUP BY portfolio.strategy_version`,
      [strategyVersion]
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Paper portfolio ${strategyVersion} does not exist.`);
    return {
      ...rowToPortfolio(row),
      cashBalanceUsd: Number(row.cash_balance_usd),
      committedExposureUsd: Number(row.committed_exposure_usd),
      realizedPnlUsd: Number(row.realized_pnl_usd),
      openPositionCount: Number(row.open_position_count)
    };
  }

  async listQualifiedPoolCandidates(
    strategyVersion: string,
    confirmationDelaySeconds: number,
    limit = 10
  ): Promise<QualifiedPoolPaperCandidate[]> {
    const result = await this.pool.query(
      `SELECT
         message.id,
         message.delivered_at,
         message.payload,
         COALESCE(
            risk.calculated_at >= NOW() - INTERVAL '30 minutes'
              AND risk.risk_score = 0
              AND risk.confidence > 0
              AND jsonb_array_length(risk.warnings) = 0,
            FALSE
          ) AS current_risk_passed
       FROM telegram_notification_outbox message
       JOIN paper_portfolios portfolio
         ON portfolio.strategy_version = $1
       LEFT JOIN LATERAL (
          SELECT
            assessment.calculated_at,
            assessment.risk_score,
            assessment.confidence,
            assessment.warnings
         FROM token_risk_assessments assessment
         WHERE assessment.chain = 'solana'
           AND assessment.token_address = message.payload->>'tokenAddress'
         ORDER BY assessment.calculated_at DESC
         LIMIT 1
       ) risk ON TRUE
       WHERE message.event_type = 'qualified-pool'
         AND message.status = 'delivered'
         AND message.delivered_at >= portfolio.activated_at
         AND message.delivered_at <= NOW() - ($2 * INTERVAL '1 second')
         AND NOT EXISTS (
           SELECT 1 FROM paper_trades trade
           WHERE trade.strategy_version = portfolio.strategy_version
             AND trade.signal_id = message.id
         )
       ORDER BY message.delivered_at, message.id
       LIMIT $3`,
      [
        strategyVersion,
        Math.max(0, Math.trunc(confirmationDelaySeconds)),
        Math.max(1, Math.min(50, Math.trunc(limit)))
      ]
    );
    return result.rows.map((row) => ({
      notificationId: String(row.id),
      deliveredAt: new Date(row.delivered_at).toISOString(),
      payload: row.payload as QualifiedPoolNotification,
      currentRiskPassed: row.current_risk_passed === true
    }));
  }

  async listOpenTrades(strategyVersion: string): Promise<PaperTrade[]> {
    const result = await this.pool.query(
      `SELECT * FROM paper_trades
       WHERE strategy_version = $1 AND status = 'open'
       ORDER BY opened_at, id`,
      [strategyVersion]
    );
    return result.rows.map(rowToPaperTrade);
  }

  async updateOpenTradeState(tradeId: string, raw: Record<string, unknown>): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE paper_trades
       SET raw = $2::jsonb
       WHERE id = $1 AND status = 'open'`,
      [tradeId, JSON.stringify(raw)]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async saveRejectedCandidate(input: {
    id: string;
    strategyVersion: string;
    signalId: string;
    tokenAddress: string;
    priceUsd: number;
    observedAt: string;
    reason: string;
    raw: Record<string, unknown>;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO paper_trades (
         id, signal_id, strategy_version, chain, token_address, side, status,
         quantity, price_usd, notional_usd, fees_usd, slippage_bps,
         opened_at, reason, raw
       )
       VALUES ($1, $2, $3, 'solana', $4, 'buy', 'rejected',
               0, $5, 0, 0, 0, $6, $7, $8::jsonb)
       ON CONFLICT (strategy_version, signal_id) DO NOTHING`,
      [
        input.id,
        input.signalId,
        input.strategyVersion,
        input.tokenAddress,
        Math.max(0, input.priceUsd),
        input.observedAt,
        input.reason,
        JSON.stringify(input.raw)
      ]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async recordTradeEvent(trade: PaperTrade, event: PaperTradeEvent): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT strategy_version FROM paper_portfolios
         WHERE strategy_version = $1 FOR UPDATE`,
        [event.strategyVersion]
      );
      const duplicate = await client.query(`SELECT 1 FROM paper_trade_events WHERE id = $1`, [
        event.id
      ]);
      if ((duplicate.rowCount ?? 0) > 0) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `INSERT INTO paper_trades (
           id, signal_id, strategy_version, chain, token_address, side, status,
           quantity, price_usd, notional_usd, fees_usd, slippage_bps,
           opened_at, closed_at, pnl_usd, reason, raw
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17::jsonb
         )
         ON CONFLICT (id) DO UPDATE SET
           side = EXCLUDED.side,
           status = EXCLUDED.status,
           quantity = EXCLUDED.quantity,
           price_usd = EXCLUDED.price_usd,
           fees_usd = EXCLUDED.fees_usd,
           slippage_bps = EXCLUDED.slippage_bps,
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
          JSON.stringify(trade.raw ?? {})
        ]
      );
      await client.query(
        `INSERT INTO paper_trade_events (
           id, trade_id, strategy_version, event_type, quantity, price_usd,
           gross_value_usd, fees_usd, cash_delta_usd, realized_pnl_usd,
           slippage_bps, liquidity_usd, occurred_at, reason, raw
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15::jsonb
         )`,
        [
          event.id,
          event.tradeId,
          event.strategyVersion,
          event.eventType,
          event.quantity,
          event.priceUsd,
          event.grossValueUsd,
          event.feesUsd,
          event.cashDeltaUsd,
          event.realizedPnlUsd,
          event.slippageBps,
          event.liquidityUsd ?? null,
          event.occurredAt,
          event.reason,
          JSON.stringify(event.raw ?? {})
        ]
      );
      await client.query(
        `UPDATE paper_portfolios SET updated_at = NOW()
         WHERE strategy_version = $1`,
        [event.strategyVersion]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function rowToPortfolio(row: Record<string, unknown>): PaperPortfolioRecord {
  return {
    strategyVersion: String(row.strategy_version),
    startingBalanceUsd: Number(row.starting_balance_usd),
    activatedAt: new Date(String(row.activated_at)).toISOString(),
    status: row.status as PaperPortfolioRecord["status"],
    config: (row.config ?? {}) as Record<string, unknown>
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
