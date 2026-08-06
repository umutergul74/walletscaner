import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import type { RuntimeConfig } from "@memecoin-alpha/config";
import { loadRuntimeConfig } from "@memecoin-alpha/config";
import { dedupeEvents } from "@memecoin-alpha/core";
import { normalizeHeliusWebhook, verifyHeliusWebhookAuth } from "@memecoin-alpha/providers";
import {
  MemoryRepository,
  PostgresRepository,
  type ApplicationRepository,
  type CanonicalChainEventInput
} from "@memecoin-alpha/db";
import type {
  ChainId,
  WalletAlphaScoreSnapshot,
  WalletAlphaSignalEvidence
} from "@memecoin-alpha/shared";

export interface AppDependencies {
  config?: RuntimeConfig;
  repository?: ApplicationRepository;
}

export function createApp(deps: AppDependencies = {}) {
  const config = deps.config ?? loadRuntimeConfig();
  const repository = deps.repository ?? createRepository(config);
  const app = express();
  type PipelineHealth = Awaited<ReturnType<ApplicationRepository["getPipelineHealth"]>>;
  let pipelineHealthCache: { value: PipelineHealth; expiresAt: number } | undefined;
  let pipelineHealthInFlight: Promise<PipelineHealth> | undefined;

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use(
    pinoHttp({
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"]
    })
  );

  app.get("/health", async (_req, res) => {
    res.json({
      status: "ok",
      service: "memecoin-alpha-api",
      liveExecutionEnabled: false,
      checkedAt: new Date().toISOString()
    });
  });

  app.get("/api/recent-tokens", async (req, res, next) => {
    try {
      const limit = Number(req.query.limit ?? 50);
      res.json({ data: await repository.listRecentTokens(limit) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tokens/:chain/:address", async (req, res, next) => {
    try {
      const token = await repository.getToken(req.params.chain as ChainId, req.params.address);
      if (!token) {
        res.status(404).json({ error: "Token not found" });
        return;
      }
      const signals = (await repository.listSignals()).filter(
        (signal) => signal.chain === token.chain && signal.tokenAddress === token.address
      );
      res.json({ data: { token, signals } });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tokens/:chain/:address/risk", async (req, res, next) => {
    try {
      const risk = await repository.getTokenRisk(req.params.chain as ChainId, req.params.address);
      const signals = (await repository.listSignals()).filter(
        (signal) => signal.chain === req.params.chain && signal.tokenAddress === req.params.address
      );
      res.json({
        data:
          risk ??
          (signals[0]
            ? {
                chain: signals[0].chain,
                tokenAddress: signals[0].tokenAddress,
                calculatedAt: signals[0].detectedAt,
                score: {
                  score: signals[0].tokenScore,
                  riskScore: signals[0].riskScore,
                  confidence: signals[0].confidence,
                  subScores: {},
                  reasons: signals[0].keyReasons,
                  warnings: signals[0].keyReasons.filter((reason) => reason.startsWith("Risk:"))
                }
              }
            : null)
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/wallets/:address", async (req, res, next) => {
    try {
      const wallet = await repository.getWallet(req.params.address);
      if (!wallet) {
        res.status(404).json({ error: "Wallet not found" });
        return;
      }
      res.json({ data: wallet });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/wallet-rankings", async (req, res, next) => {
    try {
      res.json({ data: await repository.listWalletRankings(Number(req.query.limit ?? 100)) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/wallet-alpha/rankings", async (req, res, next) => {
    try {
      const strategyVersion = readQueryString(req.query.strategyVersion);
      const statuses = readEnumList<WalletAlphaScoreSnapshot["status"]>(req.query.status);
      res.json({
        data: await repository.listWalletAlphaRankings({
          ...(strategyVersion ? { strategyVersion } : {}),
          ...(statuses ? { statuses } : {}),
          limit: readLimit(req.query.limit, 25, 100),
          offset: readOffset(req.query.offset)
        })
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/wallets/:address/alpha", async (req, res, next) => {
    try {
      const detail = await repository.getWalletAlphaDetail(
        req.params.address,
        readQueryString(req.query.strategyVersion)
      );
      if (!detail) {
        res.status(404).json({ error: "Wallet alpha profile not found" });
        return;
      }
      res.json({ data: detail });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/wallet-alpha/signals", async (req, res, next) => {
    try {
      const strategyVersion = readQueryString(req.query.strategyVersion);
      const statuses = readEnumList<WalletAlphaSignalEvidence["status"]>(req.query.status);
      res.json({
        data: await repository.listWalletAlphaSignalFeed({
          ...(strategyVersion ? { strategyVersion } : {}),
          ...(statuses ? { statuses } : {}),
          limit: readLimit(req.query.limit, 100, 500),
          offset: readOffset(req.query.offset)
        })
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/pipeline/health", async (_req, res, next) => {
    try {
      const now = Date.now();
      if (!pipelineHealthCache || pipelineHealthCache.expiresAt <= now) {
        pipelineHealthInFlight ??= repository.getPipelineHealth();
        const value = await pipelineHealthInFlight;
        pipelineHealthCache = { value, expiresAt: now + 15_000 };
        pipelineHealthInFlight = undefined;
      }
      res.set("Cache-Control", "public, max-age=10, stale-while-revalidate=20");
      res.json({ data: pipelineHealthCache.value });
    } catch (error) {
      pipelineHealthInFlight = undefined;
      next(error);
    }
  });

  app.get("/api/signals", async (req, res, next) => {
    try {
      res.json({ data: await repository.listSignals(Number(req.query.limit ?? 100)) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/paper-trades", async (req, res, next) => {
    try {
      res.json({ data: await repository.listPaperTrades(Number(req.query.limit ?? 100)) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/backtests", async (req, res, next) => {
    try {
      res.json({ data: await repository.listBacktestRuns(Number(req.query.limit ?? 25)) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/provider-status", async (_req, res, next) => {
    try {
      res.json({ data: await repository.listProviderStatus() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/config", async (_req, res) => {
    res.json({
      data: {
        thresholds: config.thresholds,
        chains: {
          solana: config.solana.enabled,
          evm: config.evm.enabled
        },
        liveExecutionEnabled: false
      }
    });
  });

  app.post("/api/webhooks/helius", async (req, res, next) => {
    try {
      const providedAuth = req.header("authorization") ?? req.header("x-helius-auth") ?? undefined;
      if (!verifyHeliusWebhookAuth(config.solana.heliusWebhookAuthHeader, providedAuth)) {
        res.status(401).json({ error: "Invalid webhook auth header" });
        return;
      }

      const events = normalizeHeliusWebhook(req.body);
      const result = dedupeEvents(events);
      const receivedAt = new Date().toISOString();
      const canonicalEvents: CanonicalChainEventInput[] = result.accepted.map((event) => ({
        idempotencyKey: event.idempotencyKey,
        chain: event.chain,
        ...(event.signature ? { signature: event.signature } : {}),
        ...(event.slot !== undefined ? { slot: event.slot } : {}),
        eventType: event.type,
        ...(event.tokenAddress ? { tokenAddress: event.tokenAddress } : {}),
        ...(event.poolAddress ? { poolAddress: event.poolAddress } : {}),
        occurredAt: event.observedAt,
        receivedAt,
        commitment: "confirmed",
        source: "helius-webhook",
        decoderVersion: "helius-normalizer-v1",
        payload: {
          address: event.poolAddress ?? event.tokenAddress ?? "helius-webhook",
          ...event.payload,
          normalizedEvent: event
        }
      }));
      const persisted = await repository.insertChainEvents(canonicalEvents);
      res.status(200).json({
        accepted: persisted.inserted,
        duplicates: persisted.duplicates,
        rejected: result.rejected.length,
        message: "Events durably accepted for canonical pipeline processing."
      });
    } catch (error) {
      next(error);
    }
  });

  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  );

  return app;
}

export function createRepository(config: RuntimeConfig): ApplicationRepository {
  const mode = process.env.REPOSITORY_MODE?.trim().toLowerCase();
  const permitsMemory = config.nodeEnv === "test" || config.nodeEnv === "demo";
  if (mode && mode !== "postgres" && mode !== "memory") {
    throw new Error(`Unsupported REPOSITORY_MODE=${mode}. Use postgres or memory.`);
  }
  if (mode === "memory") {
    if (!permitsMemory) {
      throw new Error("The memory repository is restricted to NODE_ENV=test or NODE_ENV=demo.");
    }
    return MemoryRepository.seeded(config.thresholds);
  }
  if (mode === "postgres" || !permitsMemory) return new PostgresRepository(config.databaseUrl);
  return MemoryRepository.seeded(config.thresholds);
}

function readQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readEnumList<T extends string>(value: unknown): T[] | undefined {
  const raw = readQueryString(value);
  return raw
    ? (raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) as T[])
    : undefined;
}

function readLimit(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(readQueryString(value));
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(1, Math.trunc(parsed))) : fallback;
}

function readOffset(value: unknown): number {
  const parsed = Number(readQueryString(value));
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}
