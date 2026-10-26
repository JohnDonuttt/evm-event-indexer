import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { createChainSource } from "./chain.js";
import { Store } from "./store.js";
import { createApi } from "./api.js";
import { runLoop } from "./sync.js";

const { values } = parseArgs({
  options: { config: { type: "string", short: "c", default: "indexer.config.json" } },
});

const config = loadConfig(values.config!);
const store = new Store(config.dbPath);
const chain = createChainSource(config.rpcUrl, config.contracts);

const abort = new AbortController();
const server = createApi(store, config).listen(config.port, () => {
  console.log(`indexing ${config.contracts.map((c) => c.name).join(", ")}; api on :${config.port}`);
});

const startBlock = config.contracts.reduce((min, c) => (c.startBlock < min ? c.startBlock : min), config.contracts[0]!.startBlock);

runLoop({
  chain,
  store,
  startBlock,
  confirmations: config.confirmations,
  batchSize: config.batchSize,
  checkpointsToKeep: config.checkpointsToKeep,
  pollMs: config.pollMs,
  signal: abort.signal,
  log: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    abort.abort();
    server.close();
    store.close();
    process.exit(0);
  });
}
