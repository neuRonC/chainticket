/**
 * What we do with the EventFactory / EventTicket contracts.
 *
 * These functions only talk to the chain and return data - they never
 * prompt or print, so the user interface stays separate. Only the seed
 * script holds the compiled factory artifact (it deploys the factory); the
 * role programs know nothing but the fragment ABIs below - the public
 * interface of contracts someone else deployed.
 */

import { parseAbi, parseEventLogs, type Address, type Hex } from "viem";
import type { Artifact, Chain } from "./chain";

// Fragment ABIs - the public interface of the two contracts.

const factoryAbi = parseAbi([
  "function feeFixed() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function createEvent(string name, uint256 capacity, uint256 price, uint256 resaleCap, uint256 entryBlock, uint256 endBlock) returns (uint256 eventId, address eventContract)",
  "event EventCreated(uint256 indexed eventId, address indexed eventContract, address indexed organiser, string name, uint256 capacity, uint256 price, uint256 resaleCap, uint256 entryBlock, uint256 endBlock)",
]);

const eventAbi = parseAbi([
  // reads (current state is read from the indexer's database; the chain is
  // consulted only where a client must not trust the cache)
  "function depositPerTicket() view returns (uint256)",
  "function isValidator(address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  // organiser
  "function releaseTickets(uint256 count) payable",
  "function authorizeValidator(address validator)",
  "function closeEvent()",
  // anyone (keeper)
  "function settle()",
  // users
  "function buy() payable returns (uint256)",
  "function listForResale(uint256 ticketId, uint256 askingPrice)",
  "function unlist(uint256 ticketId)",
  "function buyListed(uint256 ticketId) payable",
  "function claimRefund(uint256 ticketId)",
  // validators
  "function markUsed(uint256 ticketId)",
  "function revokeValidation(uint256 ticketId)",
  // platform
  "function sweepLeftovers()",
  // events
  "event TicketsReleased(uint256 count, uint256 totalReleased, uint256 deposit)",
  "event ValidatorAuthorized(address indexed validator)",
  "event ValidatorRevoked(address indexed validator)",
  "event TicketPurchased(uint256 indexed ticketId, address indexed buyer, uint256 price, uint256 fee)",
  "event TicketListed(uint256 indexed ticketId, uint256 price)",
  "event TicketUnlisted(uint256 indexed ticketId)",
  "event ListingSold(uint256 indexed ticketId, address indexed seller, address indexed buyer, uint256 price, uint256 fee)",
  "event TicketUsed(uint256 indexed ticketId, address indexed validator)",
  "event ValidationRevoked(uint256 indexed ticketId, address indexed validator)",
  "event EventClosed(uint256 payout)",
  "event EventSettled(uint256 payout)",
  "event RefundClaimed(uint256 indexed ticketId, address indexed holder, uint256 amount)",
  "event LeftoverSwept(uint256 amount)",
  // decodable errors from the underlying ERC-721
  "error ERC721NonexistentToken(uint256 tokenId)",
]);

// The reimbursement/subsidy branch (an extra value transfer) only runs when
// the gas price is non-zero, which gas estimation can miss - calls that end
// in one pad the estimated limit to cover it.
const SUBSIDY_GAS_PAD = 40000n;

// Factory operations.

// Deploy the factory (seed script only - needs the compiled artifact).
export async function deployFactory(
  chain: Chain,
  artifact: Artifact,
  key: Hex,
  feeFixedWei: bigint,
  feeBps: bigint,
  sweepDelayBlocks: bigint,
): Promise<Address> {
  const hash = await chain.walletFor(key).deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [feeFixedWei, feeBps, sweepDelayBlocks],
  });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  return receipt.contractAddress!;
}

// Create a new event: the factory deploys a fresh EventTicket contract.
export async function createEvent(
  chain: Chain,
  factory: Address,
  key: Hex,
  name: string,
  capacity: bigint,
  priceWei: bigint,
  resaleCapWei: bigint,
  entryBlock: bigint,
  endBlock: bigint,
): Promise<{ eventId: bigint; contract: Address }> {
  const hash = await chain.walletFor(key).writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: "createEvent",
    args: [name, capacity, priceWei, resaleCapWei, entryBlock, endBlock],
  });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  const [created] = parseEventLogs({
    abi: factoryAbi,
    logs: receipt.logs,
    eventName: "EventCreated",
  });
  return { eventId: created.args.eventId, contract: created.args.eventContract };
}

// Reads.

// The platform's pricing policy, from the chain - the single source of
// truth (config.yaml only feeds the deployment).
export async function readFeeParams(
  chain: Chain,
  factory: Address,
): Promise<{ feeFixedWei: bigint; feeBps: bigint }> {
  const [feeFixedWei, feeBps] = await Promise.all([
    chain.publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "feeFixed" }),
    chain.publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "feeBps" }),
  ]);
  return { feeFixedWei, feeBps };
}

export function readDepositPerTicket(chain: Chain, address: Address): Promise<bigint> {
  return chain.publicClient.readContract({
    address,
    abi: eventAbi,
    functionName: "depositPerTicket",
  });
}

export function isValidatorOn(
  chain: Chain,
  address: Address,
  account: Address,
): Promise<boolean> {
  return chain.publicClient.readContract({
    address,
    abi: eventAbi,
    functionName: "isValidator",
    args: [account],
  });
}

// True if `account` currently holds a ticket for this event.
export async function holdsTicket(
  chain: Chain,
  address: Address,
  account: Address,
): Promise<boolean> {
  const balance = await chain.publicClient.readContract({
    address,
    abi: eventAbi,
    functionName: "balanceOf",
    args: [account],
  });
  return balance > 0n;
}

// Writes. Every write takes the signer's private key from the login
// session - the contract enforces who may do what.

// One transaction helper for every contract write: estimate, pad the gas
// limit (the reimbursement branch only runs at a non-zero gas price, which
// estimation misses - see SUBSIDY_GAS_PAD), send, await the receipt.
async function write(
  chain: Chain,
  address: Address,
  key: Hex,
  functionName:
    | "buy"
    | "buyListed"
    | "claimRefund"
    | "markUsed"
    | "revokeValidation"
    | "settle"
    | "authorizeValidator"
    | "releaseTickets"
    | "closeEvent"
    | "listForResale"
    | "unlist"
    | "sweepLeftovers",
  args: readonly unknown[] = [],
  value?: bigint,
): Promise<Hex> {
  const wallet = chain.walletFor(key);
  const gas = await chain.publicClient.estimateContractGas({
    address,
    abi: eventAbi,
    functionName,
    args: args as never,
    value,
    account: wallet.account,
  } as never);
  const hash = await wallet.writeContract({
    address,
    abi: eventAbi,
    functionName,
    args: args as never,
    value,
    gas: gas + SUBSIDY_GAS_PAD,
  } as never);
  await chain.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export const authorizeValidator = (c: Chain, a: Address, k: Hex, v: Address) =>
  write(c, a, k, "authorizeValidator", [v]);
export const closeEvent = (c: Chain, a: Address, k: Hex) =>
  write(c, a, k, "closeEvent");
export const settle = (c: Chain, a: Address, k: Hex) =>
  write(c, a, k, "settle", []);
export const sweepLeftovers = (c: Chain, a: Address, k: Hex) =>
  write(c, a, k, "sweepLeftovers");

export const listForResale = (c: Chain, a: Address, k: Hex, id: bigint, p: bigint) =>
  write(c, a, k, "listForResale", [id, p]);
export const unlist = (c: Chain, a: Address, k: Hex, id: bigint) =>
  write(c, a, k, "unlist", [id]);
export const claimRefund = (c: Chain, a: Address, k: Hex, id: bigint) =>
  write(c, a, k, "claimRefund", [id]);

export const markUsed = (c: Chain, a: Address, k: Hex, id: bigint) =>
  write(c, a, k, "markUsed", [id]);
export const revokeValidation = (c: Chain, a: Address, k: Hex, id: bigint) =>
  write(c, a, k, "revokeValidation", [id]);

// Release a batch of tickets, attaching the required deposit.
export async function releaseTickets(
  chain: Chain,
  address: Address,
  key: Hex,
  count: bigint,
): Promise<{ hash: Hex; deposit: bigint }> {
  const deposit = (await readDepositPerTicket(chain, address)) * count;
  const hash = await write(chain, address, key, "releaseTickets", [count], deposit);
  return { hash, deposit };
}

// Buy in the primary sale; returns the new ticket's id.
export async function buy(
  chain: Chain,
  address: Address,
  key: Hex,
  priceWei: bigint,
): Promise<bigint> {
  const hash = await write(chain, address, key, "buy", [], priceWei);
  const receipt = await chain.publicClient.getTransactionReceipt({ hash });
  const [purchased] = parseEventLogs({
    abi: eventAbi,
    logs: receipt.logs,
    eventName: "TicketPurchased",
  });
  return purchased.args.ticketId;
}

// Buy a listed ticket at its asking price.
export const buyListed = (c: Chain, a: Address, k: Hex, id: bigint, p: bigint) =>
  write(c, a, k, "buyListed", [id], p);

// Event subscription and backfill - used by the indexer.

export interface DecodedLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
  address: Address;
}

function decode(log: {
  eventName: string;
  args: unknown;
  blockNumber: bigint;
  transactionHash: Hex;
  address: Address;
}): DecodedLog {
  return {
    eventName: log.eventName,
    // Zero-argument events decode with no args object.
    args: (log.args ?? {}) as Record<string, unknown>,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    address: log.address,
  };
}

type Unwatch = () => void;

export async function getPastFactoryEvents(
  chain: Chain,
  factory: Address,
): Promise<DecodedLog[]> {
  const logs = await chain.publicClient.getContractEvents({
    address: factory,
    abi: factoryAbi,
    fromBlock: 0n,
  });
  return logs.map(decode);
}

export async function getPastTicketEvents(
  chain: Chain,
  eventContract: Address,
): Promise<DecodedLog[]> {
  const logs = await chain.publicClient.getContractEvents({
    address: eventContract,
    abi: eventAbi,
    fromBlock: 0n,
  });
  return logs.map(decode);
}

export function onFactoryEvent(
  chain: Chain,
  factory: Address,
  handler: (log: DecodedLog) => void,
): Unwatch {
  return chain.publicClient.watchContractEvent({
    address: factory,
    abi: factoryAbi,
    onLogs: (logs) => logs.forEach((log) => handler(decode(log))),
    onError: (error) => console.error("factory watch error:", error.message),
  });
}

export function onTicketEvent(
  chain: Chain,
  eventContract: Address,
  handler: (log: DecodedLog) => void,
): Unwatch {
  return chain.publicClient.watchContractEvent({
    address: eventContract,
    abi: eventAbi,
    onLogs: (logs) => logs.forEach((log) => handler(decode(log))),
    onError: (error) => console.error("ticket watch error:", error.message),
  });
}
