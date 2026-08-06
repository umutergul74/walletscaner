import { loadRuntimeConfig } from "@memecoin-alpha/config";
import { createApp, createRepository } from "./app";

const config = loadRuntimeConfig();
const repository = createRepository(config);
await repository.assertReady();
const app = createApp({ config, repository });

app.listen(config.apiPort, "0.0.0.0", () => {
  console.log(`API listening on http://0.0.0.0:${config.apiPort}`);
});
