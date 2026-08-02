/**
 * Remembers the deployed EventFactory so the programs can find it.
 *
 * The seed script writes the factory's address to tmp/deployment.json;
 * every program reads it on start-up. 
 * The factory is the single well-known address of the whole system --- 
 * each event's contract address is then found through the factory's on-chain registry.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address } from "viem";

const DEPLOYMENT_PATH = "tmp/deployment.json";

export interface Deployment {
  factory: Address;
  network: string;
  deployedAt: string;
}

export function saveDeployment(deployment: Deployment) {
  mkdirSync(dirname(DEPLOYMENT_PATH), { recursive: true });
  writeFileSync(DEPLOYMENT_PATH, JSON.stringify(deployment, null, 2) + "\n");
}

export function loadDeployment(): Deployment | undefined {
  try {
    return JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Deployment;
  } catch {
    return undefined;
  }
}

// The factory address, or a clear error telling the user to seed first.
export function requireFactory(): Deployment {
  const deployment = loadDeployment();
  if (!deployment) {
    throw new Error(
      "No deployment found - run `npm run seed` first to deploy the EventFactory",
    );
  }
  return deployment;
}
