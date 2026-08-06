import "dotenv/config";
import { z } from "zod";
import type { RuntimeThresholds } from "@memecoin-alpha/shared";

const booleanFromEnv = z
  .union([z.literal("true"), z.literal("false"), z.boolean()])
  .transform((value) => value === true || value === "true");

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional()
);

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional()
);

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  API_PORT: z.coerce.number().int().positive().default(4010),
  WEB_PORT: z.coerce.number().int().positive().default(3010),
  PUBLIC_API_BASE_URL: z.string().url().default("http://localhost:4010"),
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/memecoin_alpha"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  HELIUS_API_KEY: optionalString,
  HELIUS_WEBHOOK_AUTH_HEADER: optionalString,
  HELIUS_INGEST_MODE: z.enum(["transaction-subscribe", "webhook", "rpc"]).default("rpc"),
  HELIUS_WEBHOOK_ID: optionalString,
  HELIUS_WEBHOOK_URL: optionalUrl,
  HELIUS_WEBHOOK_SYNC_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  HELIUS_WEBHOOK_MANAGEMENT_ENABLED: booleanFromEnv.default("false"),
  HELIUS_TRANSACTION_STREAM_ENABLED: booleanFromEnv.default("false"),
  HELIUS_WS_PING_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  HELIUS_WS_RECONNECT_MAX_SECONDS: z.coerce.number().int().positive().default(30),
  HELIUS_MAX_ACCOUNT_FILTERS: z.coerce.number().int().min(1).max(50_000).default(50_000),
  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  SOLANA_WS_URL: z.string().url().default("wss://api.mainnet-beta.solana.com"),
  PYTH_HERMES_URL: z.string().url().default("https://hermes.pyth.network"),
  PYTH_BENCHMARKS_URL: z.string().url().default("https://benchmarks.pyth.network"),
  PYTH_API_KEY: optionalString,
  PYTH_SOL_USD_FEED_ID: z
    .string()
    .default("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"),
  PYTH_MAX_STALENESS_SECONDS: z.coerce.number().int().positive().default(90),
  DEXSCREENER_BASE_URL: z.string().url().default("https://api.dexscreener.com"),
  DEXSCREENER_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,
  TELEGRAM_NOTIFIER_POLL_INTERVAL_MS: z.coerce.number().int().min(15_000).default(30_000),
  TELEGRAM_STATUS_INTERVAL_MINUTES: z.coerce.number().int().min(15).default(360),
  TELEGRAM_POOL_MAX_AGE_MINUTES: z.coerce.number().int().min(5).max(180).default(30),
  TELEGRAM_INITIAL_LOOKBACK_MINUTES: z.coerce.number().int().min(0).max(60).default(5),
  TELEGRAM_NOTIFICATION_CLAIM_LIMIT: z.coerce.number().int().min(1).max(20).default(1),
  DISCORD_WEBHOOK_URL: optionalUrl,
  SIGNAL_OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  ALERT_COOLDOWN_MINUTES: z.coerce.number().int().nonnegative().default(30),
  MIN_LIQUIDITY_USD: z.coerce.number().nonnegative().default(10_000),
  MIN_VOLUME_5M_USD: z.coerce.number().nonnegative().default(5_000),
  MAX_TOP_HOLDER_PERCENT: z.coerce.number().min(0).max(100).default(35),
  MAX_RUG_RISK: z.coerce.number().min(0).max(100).default(70),
  MIN_SMART_WALLET_SCORE: z.coerce.number().min(0).max(100).default(60),
  ALERT_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(65),
  PAPER_STARTING_BALANCE_USD: z.coerce.number().positive().default(10_000),
  PAPER_POSITION_SIZE_USD: z.coerce.number().positive().default(100),
  PAPER_MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(5),
  PAPER_STOP_LOSS_PERCENT: z.coerce.number().positive().default(35),
  PAPER_TAKE_PROFIT_PERCENT: z.coerce.number().positive().default(150),
  PAPER_TIME_EXIT_MINUTES: z.coerce.number().int().positive().default(240),
  ENABLE_SOLANA: booleanFromEnv.default("true"),
  ENABLE_EVM: booleanFromEnv.default("false"),
  ENABLE_LIVE_EXECUTION: booleanFromEnv.default("false")
});

export type RuntimeConfig = ReturnType<typeof loadRuntimeConfig>;

export function loadRuntimeConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = envSchema.parse(env);

  if (parsed.ENABLE_LIVE_EXECUTION) {
    throw new Error(
      "Live execution is intentionally disabled in this phase. Set ENABLE_LIVE_EXECUTION=false."
    );
  }

  const solanaRpcUrl = parsed.SOLANA_RPC_URL;
  const solanaWsUrl = parsed.SOLANA_WS_URL;

  const thresholds: RuntimeThresholds = {
    minimumLiquidityUsd: parsed.MIN_LIQUIDITY_USD,
    minimumVolume5mUsd: parsed.MIN_VOLUME_5M_USD,
    maximumTopHolderPercent: parsed.MAX_TOP_HOLDER_PERCENT,
    maximumRugRisk: parsed.MAX_RUG_RISK,
    minimumSmartWalletScore: parsed.MIN_SMART_WALLET_SCORE,
    alertMinimumConfidence: parsed.ALERT_MIN_CONFIDENCE,
    paperPositionSizeUsd: parsed.PAPER_POSITION_SIZE_USD,
    maxOpenPaperPositions: parsed.PAPER_MAX_OPEN_POSITIONS,
    stopLossPercent: parsed.PAPER_STOP_LOSS_PERCENT,
    takeProfitPercent: parsed.PAPER_TAKE_PROFIT_PERCENT,
    timeExitMinutes: parsed.PAPER_TIME_EXIT_MINUTES
  };

  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    apiPort: parsed.API_PORT,
    webPort: parsed.WEB_PORT,
    publicApiBaseUrl: parsed.PUBLIC_API_BASE_URL,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    solana: {
      enabled: parsed.ENABLE_SOLANA,
      rpcUrl: solanaRpcUrl,
      wsUrl: solanaWsUrl,
      heliusApiKey: parsed.HELIUS_API_KEY,
      heliusWebhookAuthHeader: parsed.HELIUS_WEBHOOK_AUTH_HEADER,
      ingestMode: parsed.HELIUS_INGEST_MODE,
      webhookId: parsed.HELIUS_WEBHOOK_ID,
      webhookUrl: parsed.HELIUS_WEBHOOK_URL,
      webhookSyncIntervalMinutes: parsed.HELIUS_WEBHOOK_SYNC_INTERVAL_MINUTES,
      webhookManagementEnabled: parsed.HELIUS_WEBHOOK_MANAGEMENT_ENABLED,
      transactionStreamEnabled: parsed.HELIUS_TRANSACTION_STREAM_ENABLED,
      wsPingIntervalSeconds: parsed.HELIUS_WS_PING_INTERVAL_SECONDS,
      wsReconnectMaxSeconds: parsed.HELIUS_WS_RECONNECT_MAX_SECONDS,
      maxAccountFilters: parsed.HELIUS_MAX_ACCOUNT_FILTERS
    },
    quotePrices: {
      pythHermesUrl: parsed.PYTH_HERMES_URL,
      pythBenchmarksUrl: parsed.PYTH_BENCHMARKS_URL,
      pythApiKey: parsed.PYTH_API_KEY,
      solUsdFeedId: parsed.PYTH_SOL_USD_FEED_ID,
      maxStalenessSeconds: parsed.PYTH_MAX_STALENESS_SECONDS
    },
    evm: {
      enabled: parsed.ENABLE_EVM
    },
    dexscreener: {
      baseUrl: parsed.DEXSCREENER_BASE_URL,
      pollIntervalSeconds: parsed.DEXSCREENER_POLL_INTERVAL_SECONDS
    },
    alerts: {
      telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
      telegramChatId: parsed.TELEGRAM_CHAT_ID,
      notifierPollIntervalMs: parsed.TELEGRAM_NOTIFIER_POLL_INTERVAL_MS,
      statusIntervalMinutes: parsed.TELEGRAM_STATUS_INTERVAL_MINUTES,
      poolMaxAgeMinutes: parsed.TELEGRAM_POOL_MAX_AGE_MINUTES,
      initialLookbackMinutes: parsed.TELEGRAM_INITIAL_LOOKBACK_MINUTES,
      notificationClaimLimit: parsed.TELEGRAM_NOTIFICATION_CLAIM_LIMIT,
      discordWebhookUrl: parsed.DISCORD_WEBHOOK_URL,
      outboxPollIntervalMs: parsed.SIGNAL_OUTBOX_POLL_INTERVAL_MS,
      cooldownMinutes: parsed.ALERT_COOLDOWN_MINUTES
    },
    paperTrading: {
      startingBalanceUsd: parsed.PAPER_STARTING_BALANCE_USD
    },
    thresholds,
    liveExecutionEnabled: parsed.ENABLE_LIVE_EXECUTION
  } as const;
}

export const defaultRuntimeConfig = loadRuntimeConfig({});
