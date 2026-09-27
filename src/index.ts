import { loadConfig } from "./config.js";
import { GamerHutConnector } from "./connectors/gamerhut.js";
import { notify } from "./notifier.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.store.connector !== "gamerhut") throw new Error(`Conector nao suportado: ${config.store.connector}`);
  const pix = await new GamerHutConnector(config).purchase();
  await notify(config, pix);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
