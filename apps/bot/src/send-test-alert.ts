import { loadRuntimeConfig } from "@memecoin-alpha/config";
import { buildSampleSignal } from "@memecoin-alpha/core";
import { sendDiscordAlert, sendTelegramAlert } from "./alerts";

const config = loadRuntimeConfig();
const signal = buildSampleSignal(config.thresholds);
const telegramSent = await sendTelegramAlert(signal, config);
const discordSent = await sendDiscordAlert(signal, config);

console.log(
  JSON.stringify(
    {
      telegramSent,
      discordSent,
      message: telegramSent || discordSent ? "Test alert sent." : "No alert credentials configured."
    },
    null,
    2
  )
);

