/**
 * Everything that talks to the blockchain node, plus reading the compiled contract.
 *
 * The clients ride a WebSocket transport: the programs subscribe to contract events, 
 * and over a WebSocket the node pushes each event to them as soon as it is emitted. 
 * The chain itself is built from the active network profile, so the same code runs against anvil and Sepolia.
 */

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  webSocket,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config";

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

// Build the viem clients from the configuration.
export function connect(config: Config) {
  const viemChain = defineChain({
    id: config.chainId,
    name: config.networkName,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [], webSocket: [config.providerUrl] } },
  });
  const transport = webSocket(config.providerUrl);

  const publicClient = createPublicClient({
    chain: viemChain,
    transport,
  });

  // Anvil-only test actions (mine(), used by timetravel.ts) - would fail against Sepolia. 
  // Own transport with a longer timeout: mining a large batch of blocks is real wall-clock time, past the default timeout.
  const testClient = createTestClient({
    chain: viemChain,
    mode: "anvil",
    transport: webSocket(config.providerUrl, { timeout: 300_000 }),
  });

  // A wallet client that signs and sends transactions with the given key.
  // Keys come from the local user store after login - never from a name.
  function walletFor(privateKey: Hex) {
    return createWalletClient({
      account: privateKeyToAccount(privateKey),
      chain: viemChain,
      transport,
    });
  }

  // The address a private key controls.
  function addressOf(privateKey: Hex): Address {
    return privateKeyToAccount(privateKey).address;
  }

  // The ETH balance held by an address.
  function getBalance(address: Address) {
    return publicClient.getBalance({ address });
  }

  return { publicClient, testClient, walletFor, addressOf, getBalance };
}

export type Chain = ReturnType<typeof connect>;

// Read a contract's ABI and bytecode from Foundry's output directory
// (redirected to tmp/out by foundry.toml).
export function loadArtifact(contractName: string): Artifact {
  const path = `tmp/out/${contractName}.sol/${contractName}.json`;
  const artifact = JSON.parse(readFileSync(path, "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  return { abi: artifact.abi, bytecode: artifact.bytecode.object };
}
