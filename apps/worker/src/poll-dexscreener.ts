import { loadRuntimeConfig } from "@memecoin-alpha/config";
import { generateSignal } from "@memecoin-alpha/core";
import { MemoryRepository } from "@memecoin-alpha/db";
import { DexScreenerClient } from "@memecoin-alpha/providers";
import {
  SAMPLE_HOLDER_SNAPSHOT,
  SAMPLE_WALLET_FEATURES,
  type PoolSnapshot,
  type TokenSnapshot
} from "@memecoin-alpha/shared";
import { scoreWallet } from "@memecoin-alpha/scoring";

const config = loadRuntimeConfig();
const repo = MemoryRepository.seeded(config.thresholds);
const client = new DexScreenerClient(config.dexscreener.baseUrl);

const events = await client.discoverSolanaProfiles(8);
const walletScores = SAMPLE_WALLET_FEATURES.map((features) => scoreWallet(features));

for (const event of events) {
  const payload = event.payload as { token?: TokenSnapshot; pools?: PoolSnapshot[] };
  if (!payload.token) continue;

  await repo.upsertToken(payload.token);
  for (const pool of payload.pools ?? []) await repo.upsertPool(pool);

  const signal = generateSignal({
    token: payload.token,
    holderSnapshot: SAMPLE_HOLDER_SNAPSHOT,
    walletScores,
    thresholds: config.thresholds,
    ...(payload.pools?.[0] ? { pool: payload.pools[0] } : {})
  });
  await repo.saveSignal(signal);
}

console.log(
  JSON.stringify(
    {
      provider: "dexscreener",
      acceptedEvents: events.length,
      generatedSignals: (await repo.listSignals()).length,
      note: "Signals are research-only and not financial advice."
    },
    null,
    2
  )
);
