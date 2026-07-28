/**
 * Reads config.yaml: the active network profile, the platform's pricing
 * policy, the demo accounts the seed script provisions into the user
 * store, and the shared database path.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { parseEther, type Hex } from "viem";

export interface DemoAccount {
  privateKey: Hex;
  password: string;
}

export interface Config {
  networkName: string;
  providerUrl: string;
  chainId: number;
  blockSeconds: number;
  feeFixedWei: bigint;
  feeBps: number;
  sweepDelayBlocks: number;
  accounts: Record<string, DemoAccount>;
  databasePath: string;
}

export function loadConfig(): Config {
  const data = parse(readFileSync("config.yaml", "utf8")) as {
    network: string;
    networks: Record<
      string,
      { url?: string; urlEnv?: string; chainId: number; blockSeconds: number }
    >;
    platform: { feeFixedEth: string; feeBps: number; sweepDelayBlocks: number };
    accounts: Record<string, DemoAccount>;
    database: { path: string };
  };

  const profile = data.networks[data.network];
  if (!profile) throw new Error(`Unknown network profile: ${data.network}`);

  // The URL is either written in the profile (anvil) or taken from an
  // environment variable (sepolia), so no provider secret enters the repo.
  const providerUrl = profile.url ?? process.env[profile.urlEnv ?? ""];
  if (!providerUrl) {
    throw new Error(
      `Network ${data.network} needs the ${profile.urlEnv} environment variable`,
    );
  }

  return {
    networkName: data.network,
    providerUrl,
    chainId: profile.chainId,
    blockSeconds: profile.blockSeconds,
    feeFixedWei: parseEther(data.platform.feeFixedEth),
    feeBps: data.platform.feeBps,
    sweepDelayBlocks: data.platform.sweepDelayBlocks,
    accounts: data.accounts,
    databasePath: data.database.path,
  };
}
