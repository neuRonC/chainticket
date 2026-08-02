/**
 * Deploys a fresh EventFactory and provisions the platform account.
 */

import type { Address, Hex } from "viem";
import { loadConfig, type Config } from "./config";
import { connect, loadArtifact, type Chain } from "./chain";
import { loadDeployment, saveDeployment } from "./deployment";
import { openDatabase } from "./db";
import { provisionPlatform } from "./auth";
import { deployFactory } from "./ticketing";
import * as ui from "./ui";

export async function deployPlatform(chain: Chain, config: Config): Promise<Address> {
  const deployerKey =
    config.networkName === "anvil"
      ? config.accounts.platform.privateKey
      : (process.env.SEPOLIA_PRIVATE_KEY as Hex);
  if (!deployerKey) throw new Error("Set SEPOLIA_PRIVATE_KEY to deploy on Sepolia");

  const factory = await deployFactory(
    chain,
    loadArtifact("EventFactory"),
    deployerKey,
    BigInt(config.sweepDelayBlocks),
  );
  saveDeployment({
    factory,
    network: config.networkName,
    deployedAt: new Date().toISOString(),
  });

  const db = openDatabase(config.databasePath);
  provisionPlatform(db, config, deployerKey);
  db.close();

  return factory;
}

async function main() {
  const config = loadConfig();
  const chain = connect(config);

  ui.showStartup("Deploy");

  const existing = loadDeployment();
  if (existing && existing.network === config.networkName) {
    ui.showFailure(
      `A deployment already exists (${existing.factory}) - to redeploy, delete tmp/deployment.json first`,
    );
    process.exit(1);
  }

  const factory = await deployPlatform(chain, config);
  ui.showSuccess(`EventFactory deployed: ${factory}`);

  process.exit(0);
}

// Only run as a script, not when imported by seed.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
