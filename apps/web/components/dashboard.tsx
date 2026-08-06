"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Database,
  RefreshCw,
  ShieldCheck,
  Signal as SignalIcon,
  WalletCards
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type {
  BacktestRun,
  PaperTrade,
  ProviderStatus,
  RuntimeThresholds,
  Signal,
  TokenSnapshot,
  WalletAlphaScoreSnapshot,
  WalletAlphaSignalEvidence
} from "@memecoin-alpha/shared";

interface PipelineHealth {
  database: "ok";
  checkedAt: string;
  backlog: number;
  deadLetterCount: number;
  parserSuccessRate: number;
  processingLagSlots?: number;
  oldestPendingAgeSeconds?: number;
  highQualityPriceCoverage: number;
  inbox: Record<string, number>;
}

interface DashboardData {
  signals: Signal[];
  tokens: TokenSnapshot[];
  walletAlpha: WalletAlphaScoreSnapshot[];
  walletAlphaSignals: WalletAlphaSignalEvidence[];
  pipeline: PipelineHealth;
  paperTrades: PaperTrade[];
  backtests: BacktestRun[];
  providers: ProviderStatus[];
  config: {
    thresholds: RuntimeThresholds;
    liveExecutionEnabled: boolean;
    chains: Record<string, boolean>;
  };
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? process.env.PUBLIC_API_BASE_URL ?? "http://localhost:4010";

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [
        signals,
        tokens,
        walletAlpha,
        walletAlphaSignals,
        pipeline,
        paperTrades,
        backtests,
        providers,
        config
      ] = await Promise.all([
        getApi<Signal[]>("/api/signals"),
        getApi<TokenSnapshot[]>("/api/recent-tokens"),
        getApi<WalletAlphaScoreSnapshot[]>("/api/wallet-alpha/rankings"),
        getApi<WalletAlphaSignalEvidence[]>("/api/wallet-alpha/signals"),
        getApi<PipelineHealth>("/api/pipeline/health"),
        getApi<PaperTrade[]>("/api/paper-trades"),
        getApi<BacktestRun[]>("/api/backtests"),
        getApi<ProviderStatus[]>("/api/provider-status"),
        getApi<DashboardData["config"]>("/api/config")
      ]);
      setData({
        signals,
        tokens,
        walletAlpha,
        walletAlphaSignals,
        pipeline,
        paperTrades,
        backtests,
        providers,
        config
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load dashboard data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const metrics = useMemo(() => {
    const signals = data?.signals ?? [];
    const walletAlpha = data?.walletAlpha ?? [];
    return [
      { label: "Signals", value: signals.length.toString() },
      { label: "Qualified wallets", value: walletAlpha.length.toString() },
      { label: "Alpha signals", value: (data?.walletAlphaSignals.length ?? 0).toString() },
      { label: "Pipeline backlog", value: (data?.pipeline.backlog ?? 0).toString() }
    ];
  }, [data]);

  if (loading) return <DashboardSkeleton />;
  if (error) return <DashboardError message={error} onRetry={load} />;
  if (!data) return <DashboardEmpty onRetry={load} />;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="identity">
          <div className="mark" aria-hidden="true">
            <SignalIcon size={20} />
          </div>
          <div className="titleblock">
            <p className="eyebrow">Research-only intelligence</p>
            <h1>Memecoin Alpha Intelligence</h1>
          </div>
        </div>
        <div className="top-actions">
          <ProviderChips providers={data.providers} />
          <button className="refresh" type="button" onClick={() => void load()} aria-label="Refresh dashboard">
            <RefreshCw size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="grid">
        <section className="left">
          <div className="metrics">
            {metrics.map((metric) => (
              <div className="metric" key={metric.label}>
                <p className="metric-label">{metric.label}</p>
                <p className="metric-value">{metric.value}</p>
              </div>
            ))}
          </div>

          <section className="panel" aria-labelledby="signals-heading">
            <div className="panel-head">
              <div className="panel-title">
                <Activity size={18} aria-hidden="true" />
                <h2 id="signals-heading">Signal Feed</h2>
              </div>
              <span className="chip ok">No live execution</span>
            </div>
            <SignalFeed signals={data.signals} />
          </section>

          <section className="panel" aria-labelledby="wallets-heading">
            <div className="panel-head">
              <div className="panel-title">
                <WalletCards size={18} aria-hidden="true" />
                <h2 id="wallets-heading">Wallet Alpha v2</h2>
              </div>
            </div>
            <WalletAlphaTable wallets={data.walletAlpha} />
          </section>
        </section>

        <aside className="right">
          <section className="panel" aria-labelledby="pipeline-heading">
            <div className="panel-head">
              <div className="panel-title">
                <Database size={18} aria-hidden="true" />
                <h2 id="pipeline-heading">Canonical Pipeline</h2>
              </div>
              <span className={`chip ${data.pipeline.deadLetterCount === 0 ? "ok" : "danger"}`}>
                {data.pipeline.deadLetterCount === 0 ? "Healthy" : "Needs attention"}
              </span>
            </div>
            <PipelinePanel health={data.pipeline} />
          </section>
          <section className="panel" aria-labelledby="risk-heading">
            <div className="panel-head">
              <div className="panel-title">
                <ShieldCheck size={18} aria-hidden="true" />
                <h2 id="risk-heading">Risk Breakdown</h2>
              </div>
            </div>
            <RiskPanel signal={data.signals[0]} />
          </section>

          <section className="panel" aria-labelledby="backtest-heading">
            <div className="panel-head">
              <div className="panel-title">
                <BarChart3 size={18} aria-hidden="true" />
                <h2 id="backtest-heading">Backtest Snapshot</h2>
              </div>
            </div>
            <BacktestPanel backtests={data.backtests} />
          </section>

          <section className="panel" aria-labelledby="paper-heading">
            <div className="panel-head">
              <div className="panel-title">
                <Database size={18} aria-hidden="true" />
                <h2 id="paper-heading">Paper Trading</h2>
              </div>
            </div>
            <PaperPanel trades={data.paperTrades} />
          </section>

          <section className="panel" aria-labelledby="config-heading">
            <div className="panel-head">
              <div className="panel-title">
                <AlertTriangle size={18} aria-hidden="true" />
                <h2 id="config-heading">Thresholds</h2>
              </div>
            </div>
            <ConfigPanel thresholds={data.config.thresholds} />
          </section>
        </aside>
      </div>
    </main>
  );
}

async function getApi<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`API request failed for ${path}`);
  const body = (await response.json()) as { data: T };
  return body.data;
}

function ProviderChips({ providers }: { providers: ProviderStatus[] }) {
  return (
    <div className="status-row" aria-label="Provider status">
      {providers.map((provider) => (
        <span className={`chip ${provider.status === "ok" ? "ok" : "warn"}`} key={provider.provider}>
          {provider.provider}: {provider.status.replace("_", " ")}
        </span>
      ))}
    </div>
  );
}

function SignalFeed({ signals }: { signals: Signal[] }) {
  if (signals.length === 0) {
    return (
      <div className="empty">
        <h3>No signals yet</h3>
        <p>Once ingestion produces qualified research signals, they will appear here.</p>
      </div>
    );
  }

  return (
    <div className="signal-list">
      {signals.map((signal) => (
        <article className="signal" key={signal.id}>
          <div className="signal-main">
            <div>
              <div className="token-line">
                <h3>{signal.tokenSymbol}</h3>
                <span className="chip">{signal.actionCategory}</span>
              </div>
              <p className="address">{signal.tokenAddress}</p>
            </div>
            <div className="score-stack">
              <div className="score">
                <span>Confidence</span>
                <strong>{signal.confidence}</strong>
              </div>
              <div className="score risk">
                <span>Risk</span>
                <strong>{signal.riskScore}</strong>
              </div>
              <div className="score">
                <span>Token</span>
                <strong>{signal.tokenScore}</strong>
              </div>
            </div>
          </div>
          <ul className="reason-list">
            {signal.keyReasons.slice(0, 4).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}

function WalletAlphaTable({ wallets }: { wallets: WalletAlphaScoreSnapshot[] }) {
  if (wallets.length === 0) {
    return (
      <div className="empty">
        <h3>No wallet has passed the evidence gates</h3>
        <p>Realized PnL, followability, execution quality, and risk must all mature first.</p>
      </div>
    );
  }

  return (
    <div className="table-shell">
      <table className="table">
        <thead>
          <tr>
            <th>Wallet</th>
            <th>Status</th>
            <th>Realized</th>
            <th>Followable</th>
            <th>Overall</th>
          </tr>
        </thead>
        <tbody>
          {wallets.slice(0, 8).map((wallet) => (
            <tr key={wallet.walletAddress}>
              <td className="address" title={wallet.walletAddress}>
                {shortAddress(wallet.walletAddress)}
              </td>
              <td>{wallet.status}</td>
              <td>{wallet.profitabilityScore}</td>
              <td>{wallet.followabilityScore}</td>
              <td>{wallet.overallScore}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PipelinePanel({ health }: { health: PipelineHealth }) {
  const successPercent = Math.round(health.parserSuccessRate * 10000) / 100;
  const coveragePercent = Math.round(health.highQualityPriceCoverage * 10000) / 100;
  return (
    <div className="config-grid">
      <MetricItem label="Backlog" value={health.backlog.toString()} />
      <MetricItem label="Dead letters" value={health.deadLetterCount.toString()} />
      <MetricItem label="Parser success" value={`${successPercent}%`} />
      <MetricItem label="Price quality" value={`${coveragePercent}%`} />
      <MetricItem label="Lag" value={`${health.processingLagSlots ?? 0} slots`} />
      <MetricItem
        label="Oldest pending"
        value={`${Math.round(health.oldestPendingAgeSeconds ?? 0)}s`}
      />
    </div>
  );
}

function RiskPanel({ signal }: { signal: Signal | undefined }) {
  if (!signal) {
    return (
      <div className="empty">
        <h3>No risk report</h3>
        <p>Risk breakdowns appear with generated signals.</p>
      </div>
    );
  }

  const chartData = [
    { name: "Token", value: signal.tokenScore },
    { name: "Confidence", value: signal.confidence },
    { name: "Risk", value: signal.riskScore }
  ];

  return (
    <>
      <div style={{ width: "100%", height: 190 }}>
        <ResponsiveContainer>
          <BarChart data={chartData}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="name" stroke="var(--muted)" />
            <YAxis stroke="var(--muted)" domain={[0, 100]} />
            <Tooltip contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)" }} />
            <Bar dataKey="value" fill="var(--accent)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="chip-row">
        <span className="chip">Liquidity ${formatUsd(signal.liquiditySnapshot.liquidityUsd)}</span>
        <span className="chip">Top holder {signal.holderSnapshot.topHolderPercent}%</span>
        <span className="chip">Buys {signal.volumeSnapshot.buys5m}</span>
        <span className="chip">Sells {signal.volumeSnapshot.sells5m}</span>
      </div>
    </>
  );
}

function BacktestPanel({ backtests }: { backtests: BacktestRun[] }) {
  const run = backtests[0];
  if (!run) {
    return (
      <div className="empty">
        <h3>No backtest run saved</h3>
        <p>Run the replay command to populate historical reports.</p>
      </div>
    );
  }

  return (
    <div className="config-grid">
      <MetricItem label="Paper PnL" value={`$${run.metrics.totalPnlUsd}`} />
      <MetricItem label="Win rate" value={`${Math.round(run.metrics.winRate * 100)}%`} />
      <MetricItem label="Profit factor" value={run.metrics.profitFactor.toString()} />
      <MetricItem label="Drawdown" value={`$${run.metrics.maxDrawdownUsd}`} />
    </div>
  );
}

function PaperPanel({ trades }: { trades: PaperTrade[] }) {
  if (trades.length === 0) {
    return (
      <div className="empty">
        <h3>No paper trades</h3>
        <p>Paper positions open only when a signal passes the configured risk gates.</p>
      </div>
    );
  }

  return (
    <div className="table-shell">
      <table className="table">
        <thead>
          <tr>
            <th>Token</th>
            <th>Status</th>
            <th>PnL</th>
          </tr>
        </thead>
        <tbody>
          {trades.slice(0, 5).map((trade) => (
            <tr key={trade.id}>
              <td className="address">{shortAddress(trade.tokenAddress)}</td>
              <td>{trade.status}</td>
              <td className={trade.pnlUsd && trade.pnlUsd < 0 ? "danger-text" : ""}>
                {trade.pnlUsd === undefined ? "-" : `$${trade.pnlUsd}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConfigPanel({ thresholds }: { thresholds: RuntimeThresholds }) {
  return (
    <div className="config-grid">
      <MetricItem label="Min liquidity" value={`$${formatUsd(thresholds.minimumLiquidityUsd)}`} />
      <MetricItem label="Min 5m volume" value={`$${formatUsd(thresholds.minimumVolume5mUsd)}`} />
      <MetricItem label="Max top holder" value={`${thresholds.maximumTopHolderPercent}%`} />
      <MetricItem label="Max rug risk" value={thresholds.maximumRugRisk.toString()} />
      <MetricItem label="Paper size" value={`$${thresholds.paperPositionSizeUsd}`} />
      <MetricItem label="Max positions" value={thresholds.maxOpenPaperPositions.toString()} />
    </div>
  );
}

function MetricItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="config-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <main className="shell">
      <div className="skeleton">
        <h1>Memecoin Alpha Intelligence</h1>
        {Array.from({ length: 8 }).map((_, index) => (
          <div className={`skeleton-line ${index % 3 === 0 ? "short" : ""}`} key={index} />
        ))}
      </div>
    </main>
  );
}

function DashboardError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="shell">
      <div className="error">
        <h1>Dashboard data did not load</h1>
        <p>{message}. Check that the API is running, then retry.</p>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    </main>
  );
}

function DashboardEmpty({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="shell">
      <div className="empty">
        <h1>No dashboard data</h1>
        <p>The API returned no data. Refresh after ingestion starts.</p>
        <button type="button" onClick={onRetry}>
          Refresh
        </button>
      </div>
    </main>
  );
}

function shortAddress(address: string) {
  return address.length > 16 ? `${address.slice(0, 6)}...${address.slice(-6)}` : address;
}

function formatUsd(value: number) {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
