import type { RuntimeConfig } from "@memecoin-alpha/config";
import type {
  PaperTradeNotification,
  PipelineStatusNotification,
  QualifiedPoolNotification,
  Signal,
  WalletAlphaSignalEvidence
} from "@memecoin-alpha/shared";

export function formatSignalAlert(signal: Signal): string {
  return [
    `${signal.tokenSymbol} (${signal.chain})`,
    `Action: ${signal.actionCategory}`,
    `Confidence: ${signal.confidence} | Risk: ${signal.riskScore} | Token score: ${signal.tokenScore}`,
    `Liquidity: $${Math.round(signal.liquiditySnapshot.liquidityUsd).toLocaleString()}`,
    "",
    signal.keyReasons
      .slice(0, 5)
      .map((reason) => `- ${reason}`)
      .join("\n"),
    "",
    "Research signal only. Not financial advice."
  ].join("\n");
}

export async function sendTelegramAlert(signal: Signal, config: RuntimeConfig): Promise<boolean> {
  return sendTelegramMessage(formatSignalAlert(signal), config);
}

export async function sendDiscordAlert(signal: Signal, config: RuntimeConfig): Promise<boolean> {
  const webhookUrl = config.alerts.discordWebhookUrl;
  if (!webhookUrl) return false;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: formatSignalAlert(signal),
      allowed_mentions: { parse: [] }
    })
  });
  return response.ok;
}

export function formatWalletAlphaAlert(signal: WalletAlphaSignalEvidence): string {
  const wallets = signal.walletAddresses.slice(0, 5).join(", ");
  return [
    `Wallet alpha ${signal.status}`,
    `Token: ${signal.tokenAddress}`,
    `Confidence: ${signal.confidence}`,
    `Observed price: $${signal.observedPriceUsd}`,
    `Liquidity: $${Math.round(signal.observedLiquidityUsd).toLocaleString()}`,
    `Qualified wallets: ${wallets || "none"}`,
    "",
    "Paper/research signal only. Live execution is disabled."
  ].join("\n");
}

export function formatQualifiedPoolAlert(pool: QualifiedPoolNotification): string {
  const strict = pool.qualificationVersion !== undefined;
  return [
    strict ? "🔬 Sıkı filtreyi geçen yeni token adayı" : "🆕 Yeni token araştırma adayı",
    `Token: ${pool.tokenSymbol} — ${pool.tokenName}`,
    `Mint: ${pool.tokenAddress}`,
    `Pool: ${pool.poolAddress}`,
    `DEX/Program: ${pool.dex}`,
    `Likidite: ${formatUsd(pool.liquidityUsd)}`,
    `5 dk hacim: ${formatUsd(pool.volume5mUsd)}`,
    ...(pool.poolAgeMinutes !== undefined
      ? [`Havuz yaşı: ${pool.poolAgeMinutes.toFixed(1)} dk`]
      : []),
    ...(pool.buys5m !== undefined && pool.sells5m !== undefined
      ? [`5 dk akış: ${pool.buys5m} alış / ${pool.sells5m} satış`]
      : []),
    ...(pool.buyShare5m !== undefined && pool.volumeLiquidityRatio !== undefined
      ? [
          `Alış payı: ${formatPercent(pool.buyShare5m * 100)} | Hacim/likidite: ${pool.volumeLiquidityRatio.toFixed(2)}`
        ]
      : []),
    ...(pool.top10HolderPercent !== undefined
      ? [`Top-10 holder yoğunluğu: ${formatPercent(pool.top10HolderPercent)}`]
      : []),
    ...(pool.priceUsd !== undefined ? [`Fiyat: ${formatUsd(pool.priceUsd, 8)}`] : []),
    ...(pool.marketCapUsd !== undefined ? [`Market cap: ${formatUsd(pool.marketCapUsd)}`] : []),
    `Token risk skoru: ${pool.riskScore.toFixed(0)}/100 (düşük daha iyi)`,
    `Risk kanıt kapsamı: ${pool.riskConfidence.toFixed(0)}/100 (kâr olasılığı değildir)`,
    ...(pool.qualificationVersion ? [`Filtre sürümü: ${pool.qualificationVersion}`] : []),
    `DexScreener: https://dexscreener.com/solana/${pool.poolAddress}`,
    "",
    strict
      ? "Future-only araştırma/paper adayıdır; kanıtlanmış alpha veya alım tavsiyesi değildir."
      : "Araştırma bildirimi; finansal tavsiye değildir. Canlı işlem kapalıdır."
  ].join("\n");
}

export function formatPipelineStatusAlert(status: PipelineStatusNotification): string {
  if (status.coverageTransition) {
    const incident = status.coverageTransition;
    const reconciled = incident.transition === "coverage-reconciled";
    const recovered = incident.transition !== "opened";
    return [
      recovered
        ? reconciled
          ? "✅ Solana discovery gap'i doğrulanarak onarıldı"
          : "✅ Solana discovery transportu yeniden sağlıklı"
        : "🚨 Solana discovery coverage incident",
      `Pipeline: ${status.pipelineStatus.toUpperCase()}`,
      `Program: ${incident.programAddress}`,
      `Provider: ${incident.provider}`,
      `Neden: ${incident.reason}`,
      `Gap başlangıcı: ${incident.gapStartedAt}`,
      `Geçiş zamanı: ${incident.transitionAt}`,
      ...(incident.clusterSlot !== undefined
        ? [
            `Cluster/source slot: ${incident.clusterSlot.toLocaleString("en-US")} / ${
              incident.sourceSlot?.toLocaleString("en-US") ?? "bilinmiyor"
            }`
          ]
        : []),
      ...(incident.slotLag !== undefined ? [`Head lag: ${incident.slotLag} slot`] : []),
      ...(incident.silenceMs !== undefined
        ? [`Ham WS sessizliği: ${(incident.silenceMs / 1_000).toFixed(1)} sn`]
        : []),
      "",
      recovered
        ? reconciled
          ? "Dayanıklı oldest-first replay cursor sınırına ulaştı ve bağımsız chain head kontrolü eşleşti; bu aralık coverage açısından uzlaştırıldı."
          : "Canlı taşıma düzeldi; kayıtlı gap complete sayılmadı ve bu aralık alpha coverage dışıdır."
        : "Bu aralık alpha coverage dışıdır; eksik dönem complete sayılmayacaktır.",
      "Observe-only mod; canlı işlem kapalıdır."
    ].join("\n");
  }
  const lastPool = formatAge(status.lastPoolAgeSeconds);
  const lastTrade = formatAge(status.lastWalletTradeAgeSeconds);
  const coverageIncidents = status.openCoverageIncidents ?? [];
  const operational = status.operationalHealth;
  return [
    `📊 Walletscaner durum: ${status.pipelineStatus.toUpperCase()}`,
    `Inbox backlog / dead-letter: ${status.inboxBacklog} / ${status.deadLetters}`,
    `Alpha iş kuyruğu: ${status.alphaQueuePending.toLocaleString("en-US")}`,
    ...(status.alphaQueueSignalPending !== undefined
      ? [
          `Alpha lane S/E/B: ${status.alphaQueueSignalPending.toLocaleString("en-US")} / ${(status.alphaQueueElevatedPending ?? 0).toLocaleString("en-US")} / ${(status.alphaQueueBackgroundPending ?? 0).toLocaleString("en-US")}`
        ]
      : []),
    ...(status.alphaQueueReady !== undefined
      ? [
          `Alpha hazır / hata / karantina: ${status.alphaQueueReady.toLocaleString("en-US")} / ${(status.alphaQueueFailed ?? 0).toLocaleString("en-US")} / ${(status.alphaQueueQuarantined ?? 0).toLocaleString("en-US")}`
        ]
      : []),
    ...(status.alphaQueueOldestReadyAgeSeconds !== undefined
      ? [`En eski hazır alpha işi: ${formatAge(status.alphaQueueOldestReadyAgeSeconds)}`]
      : []),
    `Son 24s sinyal: ${status.signals24h}`,
    `Son 24s sıkı filtre token adayı: ${status.qualifiedPools24h}`,
    `Son pool yaşı: ${lastPool}`,
    `Son wallet trade yaşı: ${lastTrade}`,
    `Açık discovery coverage incident: ${status.openCoverageIncidentCount ?? 0}`,
    ...coverageIncidents.map(
      (incident) =>
        `Coverage dışı: ${shortAddress(incident.programAddress)} | gap ${incident.gapStartedAt} | ${incident.reason}`
    ),
    `Veritabanı: ${(status.databaseBytes / 1024 ** 3).toFixed(2)} GiB`,
    ...(operational
      ? [
          `Operasyon/depolama: ${operational.status.toUpperCase()}`,
          ...(operational.diskAvailableBytes !== undefined
            ? [
                `Disk boş: ${(operational.diskAvailableBytes / 1024 ** 3).toFixed(2)} GiB (${(operational.diskUsedPercent ?? 0).toFixed(1)}% kullanım)`
              ]
            : []),
          ...(operational.chainPayloadCompactionLagSeconds !== undefined
            ? [
                `Payload compaction gecikmesi: ${formatAge(operational.chainPayloadCompactionLagSeconds)}`
              ]
            : []),
          ...(operational.walletArchivePendingSegments !== undefined
            ? [
                `Wallet arşiv bekleyen / compact gün: ${operational.walletArchivePendingSegments} / ${operational.walletCompactPendingDays ?? 0}`
              ]
            : []),
          ...(operational.walletArchiveLagSeconds !== undefined
            ? [
                `Wallet arşiv / compact gecikme: ${formatAge(operational.walletArchiveLagSeconds)} / ${formatAge(operational.walletCompactLagSeconds ?? 0)}`
              ]
            : []),
          ...((operational.walletCompactMismatchDays ?? 0) > 0
            ? [`Wallet compact parity hatası: ${operational.walletCompactMismatchDays}`]
            : []),
          ...operational.reasons.slice(0, 3).map((reason) => `Durum nedeni: ${reason}`)
        ]
      : []),
    "",
    "Observe-only mod; canlı işlem kapalıdır."
  ].join("\n");
}

export function formatPaperTradeAlert(event: PaperTradeNotification): string {
  if (event.action === "portfolio-started") {
    return [
      "🧪 Paper portföyü başlatıldı",
      `Başlangıç bakiyesi: ${formatUsd(event.startingBalanceUsd)}`,
      `Kullanılabilir nakit: ${formatUsd(event.balanceUsd)}`,
      `Strateji: ${event.strategyVersion}`,
      "",
      event.reason,
      "Gerçek alım-satım yapılmaz; canlı işlem kapalıdır."
    ].join("\n");
  }
  const title = {
    opened: "🟢 PAPER ALIM",
    "partial-exit": "🟡 PAPER KISMİ SATIŞ",
    closed: "🔴 PAPER POZİSYON KAPANDI",
    rugged: "⚠️ PAPER RUG / SATILAMAZ KABULÜ"
  }[event.action];
  return [
    title,
    `Token: ${event.tokenSymbol ?? shortAddress(event.tokenAddress ?? "")}`,
    `Mint: ${event.tokenAddress ?? "bilinmiyor"}`,
    ...(event.poolAddress
      ? [
          `Pool: ${event.poolAddress}`,
          `DexScreener: https://dexscreener.com/solana/${event.poolAddress}`
        ]
      : []),
    ...(event.priceUsd !== undefined ? [`Paper fiyat: ${formatUsd(event.priceUsd, 10)}`] : []),
    ...(event.notionalUsd !== undefined ? [`Pozisyon: ${formatUsd(event.notionalUsd)}`] : []),
    ...(event.proceedsUsd !== undefined ? [`Net satış: ${formatUsd(event.proceedsUsd)}`] : []),
    ...(event.pnlUsd !== undefined ? [`Gerçekleşen PnL: ${formatSignedUsd(event.pnlUsd)}`] : []),
    ...(event.returnPercent !== undefined
      ? [`İşlem getirisi: ${formatSignedPercent(event.returnPercent)}`]
      : []),
    ...(event.liquidityUsd !== undefined
      ? [`Gözlenen likidite: ${formatUsd(event.liquidityUsd)}`]
      : []),
    `Nakit: ${formatUsd(event.balanceUsd)} | Açık pozisyon: ${event.openPositionCount}`,
    `Neden: ${event.reason}`,
    "",
    "Paper simülasyonu; gerçek emir gönderilmedi."
  ].join("\n");
}

export async function sendTelegramMessage(text: string, config: RuntimeConfig): Promise<boolean> {
  const token = config.alerts.telegramBotToken;
  const chatId = config.alerts.telegramChatId;
  if (!token || !chatId) return false;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(10_000)
  });
  return response.ok;
}

export async function sendWalletAlphaTelegramAlert(
  signal: WalletAlphaSignalEvidence,
  config: RuntimeConfig
): Promise<boolean> {
  return sendTelegramMessage(formatWalletAlphaAlert(signal), config);
}

function formatUsd(value: number, maximumFractionDigits = 2): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits })}`;
}

function formatAge(seconds: number | undefined): string {
  if (seconds === undefined) return "bilinmiyor";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} sn`;
  return `${(seconds / 60).toFixed(1)} dk`;
}

function formatSignedUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatUsd(Math.abs(value))}`;
}

function formatSignedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function shortAddress(address: string): string {
  return address.length > 8 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
}

export async function sendWalletAlphaDiscordAlert(
  signal: WalletAlphaSignalEvidence,
  config: RuntimeConfig
): Promise<boolean> {
  const webhookUrl = config.alerts.discordWebhookUrl;
  if (!webhookUrl) return false;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: formatWalletAlphaAlert(signal),
      allowed_mentions: { parse: [] }
    })
  });
  return response.ok;
}
