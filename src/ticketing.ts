/**
 * What we do with the EventFactory / EventTicket contracts.
 *
 * These functions only talk to the chain and return data.
 * The role programs know nothing but the fragment ABIs below - the public interface of contracts someone else deployed.
 */

import { keccak256, parseAbi, parseEventLogs, toBytes, type Address, type Hex } from "viem";
import type { Artifact, Chain } from "./chain";

// Fragment ABIs - the public interface of the two contracts.

const factoryAbi = parseAbi([
  "function createEvent(string name, uint256 capacity, uint256 price, uint256 resaleCap, uint256 entryBlock, uint256 endBlock) returns (uint256 eventId, address eventContract)",
  "event EventCreated(uint256 indexed eventId, address indexed eventContract, address indexed organiser, string name, uint256 capacity, uint256 price, uint256 resaleCap, uint256 entryBlock, uint256 endBlock)",
]);

const eventAbi = parseAbi([
  "function isValidator(address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  // organiser
  "function releaseTickets(uint256 count)",
  "function authorizeValidator(address validator)",
  "function revokeValidator(address validator)",
  "function closeEvent()",
  // anyone (keeper)
  "function settle()",
  // users
  "function buy() payable returns (uint256)",
  "function listForResale(uint256 ticketId, uint256 askingPrice)",
  "function unlist(uint256 ticketId)",
  "function buyListed(uint256 ticketId) payable",
  "function claimRefund(uint256 ticketId)",
  "function setCheckInCode(uint256 ticketId, bytes32 codeHash)",
  // validators
  "function markUsed(uint256 ticketId, string code)",
  // platform
  "function sweepLeftovers()",
  // events
  "event TicketsReleased(uint256 count, uint256 totalReleased)",
  "event ValidatorAuthorized(address indexed validator)",
  "event ValidatorRevoked(address indexed validator)",
  "event TicketPurchased(uint256 indexed ticketId, address indexed buyer, uint256 price)",
  "event TicketListed(uint256 indexed ticketId, uint256 price)",
  "event TicketUnlisted(uint256 indexed ticketId)",
  "event ListingSold(uint256 indexed ticketId, address indexed seller, address indexed buyer, uint256 price)",
  "event CheckInCodeSet(uint256 indexed ticketId)",
  "event TicketUsed(uint256 indexed ticketId, address indexed validator)",
  "event EventClosed(uint256 payout)",
  "event EventSettled(uint256 payout)",
  "event RefundClaimed(uint256 indexed ticketId, address indexed holder, uint256 amount)",
  "event LeftoverSwept(uint256 amount)",
  // decodable errors from the underlying ERC-721
  "error ERC721NonexistentToken(uint256 tokenId)",
]);

// Factory operations.

// Deploy the factory (seed script only - needs the compiled artifact).
export async function deployFactory(
  chain: Chain,
  artifact: Artifact,
  key: Hex,
  sweepDelayBlocks: bigint,
): Promise<Address> {
  const hash = await chain.walletFor(key).deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [sweepDelayBlocks],
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

// Writes. Every write takes the signer's private key from the login session - the contract enforces who may do what. 
// Whoever sends the transaction pays its own gas; there is no reimbursement.

// One transaction helper for every contract write: estimate, send, await the receipt.
async function write(
  chain: Chain,
  address: Address,
  key: Hex,
  functionName:
    | "buy"
    | "buyListed"
    | "claimRefund"
    | "setCheckInCode"
    | "markUsed"
    | "settle"
    | "authorizeValidator"
    | "revokeValidator"
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
    gas,
  } as never);
  await chain.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export const authorizeValidator = (c: Chain, a: Address, k: Hex, v: Address) =>
  write(c, a, k, "authorizeValidator", [v]);
export const revokeValidator = (c: Chain, a: Address, k: Hex, v: Address) =>
  write(c, a, k, "revokeValidator", [v]);
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

// keccak256 of a check-in code's plaintext, matching the contract's keccak256(abi.encodePacked(code)) - the commit half of check-in.
// Case-normalised so a validator retyping the code isn't tripped up by case.
export const hashCheckInCode = (code: string) => keccak256(toBytes(code.toUpperCase()));

export const setCheckInCode = (c: Chain, a: Address, k: Hex, id: bigint, codeHash: Hex) =>
  write(c, a, k, "setCheckInCode", [id, codeHash]);
export const markUsed = (c: Chain, a: Address, k: Hex, id: bigint, code: string) =>
  write(c, a, k, "markUsed", [id, code]);

// Release a batch of tickets for sale.
export const releaseTickets = (c: Chain, a: Address, k: Hex, count: bigint) =>
  write(c, a, k, "releaseTickets", [count]);

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
