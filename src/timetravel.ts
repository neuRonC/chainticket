#!/usr/bin/env -S npx tsx
/**
 * Fast-forwards the local anvil chain for a demo: mines enough empty
 * blocks to advance by roughly the given number of minutes, converted
 * using the network's block interval (config.yaml's blockSeconds). Wraps
 * `cast rpc anvil_mine <hex blocks>` so the demo can think in minutes.
 *
 * Run directly from the project root: `./src/timetravel.ts <minutes>`
 * (or `npm run timetravel -- <minutes>`).
 */

import { loadConfig } from "./config";
import { connect } from "./chain";

async function main() {
  const config = loadConfig();
  const minutes = Number(process.argv[2]);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.error("Usage: ./src/timetravel.ts <minutes>");
    process.exit(1);
  }

  const blocks = Math.ceil((minutes * 60) / config.blockSeconds);
  const chain = connect(config);
  await chain.testClient.mine({ blocks });
  console.log(`⏱ Mined ${blocks} blocks (~${minutes} min at ${config.blockSeconds}s/block)`);
  process.exit(0);
}

main();
